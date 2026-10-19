// Pairwise sessions between two devices (docs/encryption-design-v2.md §4.6): X3DH on first contact,
// then the Double Ratchet. Each app supplies storage (ProtocolStore); this file does the protocol.
//
// - The first messages of a session carry X3DH data ("pkmsg") until the other side replies.
// - If both devices start a session at once, both sessions are kept for a while; whichever decrypts
//   becomes current (as in Signal).
// - decrypt() doesn't save anything: it returns commit(), which the app calls in the same local
//   database transaction that stores the message, so a crash can't lose a message key.

import { b64, CryptoError, KeyPair, unb64 } from './primitives';
import type { DeviceIdentity, DevicePublic } from './identity';
import type { PreKeyBundle } from './prekeys';
import { x3dhInitiate, x3dhRespond } from './x3dh';
import {
  canSend, initReceiver, initSender, loadRatchet, ratchetDecrypt, ratchetEncrypt, RatchetState, storeRatchet, StoredRatchet,
} from './ratchet';

export interface Address { user: string; device: number }
export const addressKey = (a: Address): string => `${a.user}:${a.device}`;

export interface PreKeyInfo {
  ik: string; // sender device identity (Ed25519), b64
  ikdh: string; // sender device identity (X25519), b64
  ek: string; // X3DH ephemeral key, b64
  spk: number;
  opk?: number;
}

interface StoredState {
  ratchet: StoredRatchet;
  baseKey: string; // the X3DH ephemeral key this session started from (identifies it)
  pending?: PreKeyInfo; // sent with every message until the other side answers
}

export interface SessionRecord {
  theirSign: string; // the device identity this session belongs to
  theirDh: string;
  current: StoredState;
  previous: StoredState[]; // recent replaced sessions, for messages still in flight
}

const MAX_PREVIOUS = 4;

export interface ProtocolStore {
  identity(): Promise<DeviceIdentity>;
  loadSession(peer: Address): Promise<SessionRecord | null>;
  saveSession(peer: Address, record: SessionRecord): Promise<void>;
  signedPreKey(id: number): Promise<KeyPair | null>;
  oneTimePreKey(id: number): Promise<KeyPair | null>;
  removeOneTimePreKey(id: number): Promise<void>;
}

export interface EncryptedForDevice {
  kind: 'pkmsg' | 'msg';
  pre?: PreKeyInfo;
  header: Uint8Array;
  ciphertext: Uint8Array;
}

const sameDevice = (record: SessionRecord, device: DevicePublic) => record.theirSign === device.sign && record.theirDh === device.dh;

/**
 * Encrypt for one device. `device` must come from that user's verified device list; `fetchBundle`
 * is only called when there's no session yet.
 */
/** Does sending to this device need a new session first (its prekey bundle fetched)? */
export async function needsSession(store: ProtocolStore, peer: Address, device: DevicePublic): Promise<boolean> {
  const record = await store.loadSession(peer);
  return !record || !sameDevice(record, device) || !canSend(loadRatchet(record.current.ratchet));
}

export async function encryptFor(
  store: ProtocolStore, peer: Address, device: DevicePublic, plaintext: Uint8Array, fetchBundle: () => Promise<PreKeyBundle>,
): Promise<EncryptedForDevice> {
  const me = await store.identity();
  let record = await store.loadSession(peer);
  if (record && !sameDevice(record, device)) record = null; // the device was re-registered: start over

  if (!record || !canSend(loadRatchet(record.current.ratchet))) {
    const bundle = await fetchBundle();
    if (bundle.identitySign !== device.sign || bundle.identityDh !== device.dh) {
      throw new CryptoError('bad_signature', "Prekeys don't belong to the verified device");
    }
    const x = x3dhInitiate(me, bundle);
    const state: StoredState = {
      ratchet: storeRatchet(initSender(x.sk, x.ad, x.theirRatchetKey)),
      baseKey: b64(x.ephemeralPub),
      pending: { ik: b64(me.sign.pub), ikdh: b64(me.dh.pub), ek: b64(x.ephemeralPub), spk: x.signedPreKeyId, opk: x.oneTimePreKeyId },
    };
    record = {
      theirSign: device.sign, theirDh: device.dh, current: state,
      previous: record ? [record.current, ...record.previous].slice(0, MAX_PREVIOUS) : [],
    };
  }

  const ratchet = loadRatchet(record.current.ratchet);
  const { header, ciphertext } = ratchetEncrypt(ratchet, plaintext);
  record.current = { ...record.current, ratchet: storeRatchet(ratchet) };
  await store.saveSession(peer, record); // saved before sending: a key is never reused
  const pre = record.current.pending;
  return pre ? { kind: 'pkmsg', pre, header, ciphertext } : { kind: 'msg', header, ciphertext };
}

/**
 * Decrypt a packet from one device. `device` must come from the sender's verified device list.
 * Nothing is stored until commit() is called.
 */
export async function decryptFrom(
  store: ProtocolStore, peer: Address, device: DevicePublic, packet: EncryptedForDevice,
): Promise<{ plaintext: Uint8Array; commit: () => Promise<void> }> {
  const existing = await store.loadSession(peer);
  const record: SessionRecord | null = existing && sameDevice(existing, device) ? existing : null;
  const candidates: { state: StoredState; index: number }[] = [];
  if (record) {
    candidates.push({ state: record.current, index: -1 });
    record.previous.forEach((state, index) => candidates.push({ state, index }));
  }

  let fresh: { state: StoredState; usedOpk?: number } | null = null;
  if (packet.kind === 'pkmsg') {
    const pre = packet.pre;
    if (!pre || pre.ik !== device.sign || pre.ikdh !== device.dh) throw new CryptoError('bad_signature', 'Prekey message from an unverified device');
    const known = candidates.find((c) => c.state.baseKey === pre.ek);
    if (!known) {
      const me = await store.identity();
      const spk = await store.signedPreKey(pre.spk);
      if (!spk) throw new CryptoError('no_session', 'Unknown signed prekey');
      const opk = pre.opk !== undefined ? await store.oneTimePreKey(pre.opk) : null;
      if (pre.opk !== undefined && !opk) throw new CryptoError('replay', 'One-time prekey already used');
      const x = x3dhRespond(me, spk, opk || undefined, { identitySign: unb64(pre.ik), identityDh: unb64(pre.ikdh), ephemeral: unb64(pre.ek) });
      fresh = { state: { ratchet: storeRatchet(initReceiver(x.sk, x.ad, spk)), baseKey: pre.ek }, usedOpk: pre.opk };
    }
  }

  const attempts = fresh ? [{ state: fresh.state, index: -2 }, ...candidates] : candidates;
  if (!attempts.length) throw new CryptoError('no_session', 'No session with this device');
  let lastError: unknown = null;
  for (const attempt of attempts) {
    let result: { state: RatchetState; plaintext: Uint8Array };
    try {
      result = ratchetDecrypt(loadRatchet(attempt.state.ratchet), packet.header, packet.ciphertext);
    } catch (e) {
      lastError = e;
      continue;
    }
    // Anything decrypted on a session we started is their reply: they have our prekey data, stop resending it
    const updated: StoredState = { ratchet: storeRatchet(result.state), baseKey: attempt.state.baseKey };
    const others = [record?.current, ...(record?.previous || [])].filter(
      (s): s is StoredState => !!s && s.baseKey !== attempt.state.baseKey,
    );
    const next: SessionRecord = { theirSign: device.sign, theirDh: device.dh, current: updated, previous: others.slice(0, MAX_PREVIOUS) };
    const usedOpk = attempt.index === -2 ? fresh?.usedOpk : undefined;
    return {
      plaintext: result.plaintext,
      commit: async () => {
        await store.saveSession(peer, next);
        if (usedOpk !== undefined) await store.removeOneTimePreKey(usedOpk);
      },
    };
  }
  throw lastError instanceof CryptoError ? lastError : new CryptoError('decrypt_failed', 'Message could not be decrypted');
}
