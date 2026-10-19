// Sending and receiving with end-to-end encryption v2 (docs/encryption-design-v2.md §4-6, phase 4).
// Platform-neutral: the apps give it their encrypted store and HTTP client, put the returned
// envelopes on the WebSocket, and hand it the envelopes that arrive.
//
// - Device directory: each person's signed device list, checked against the account key pinned the
//   first time it was seen (a changed key is accepted but recorded, for "security code changed").
// - Direct chats: one Double Ratchet session per pair of devices; the message is encrypted for each
//   of the other person's devices and for this account's other devices (so they show it too).
// - Groups: Sender Keys. Our sender key goes to every member device once (inside pairwise messages)
//   and is replaced when a member or device leaves; each message is then encrypted once.
// - Receiving: decrypt, store the message in the local database, all in one transaction.

import { CryptoError, b64 } from './primitives';
import type { DeviceList, DevicePublic } from './identity';
import { verifyDeviceList } from './identity';
import { decodeBody, encodeBody, MessageBody } from './body';
import { decryptFrom, encryptFor, Address, needsSession } from './session';
import type { PreKeyBundle } from './prekeys';
import { distribution, fromDistribution, groupDecrypt, groupEncrypt, needsRotation, newSenderKey } from './senderKeys';
import { fromGroupPacket, fromMessagePacket, GroupPacket, MessagePacket, senderName, toGroupPacket, toMessagePacket } from './packets';
import type { E2EHttp } from './device';
import { httpStatus, isTransientHttpError } from './device';
import type { EncryptedStore, LocalMessage, StoreView } from './storage';

export interface OutgoingEnvelope { to_user: string; to_device: number; packet: MessagePacket | GroupPacket }

export interface IncomingEnvelope {
  id: string;
  from: Address;
  conversation_id: string | null;
  message_id: string | null;
  packet: MessagePacket | GroupPacket;
}

/**
 * What the server says about a new message, next to each device's packet (protocol 3): enough to show
 * it in the chat as soon as the packet is decrypted, or as "Waiting for this message…" if it can't be.
 */
export interface EnvelopeMeta {
  messageId: string;
  roomId: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string | null;
  messageType?: string;
  mediaType?: string | null;
  mediaUrl?: string | null;
  mediaThumbnail?: string | null;
  replyTo?: { id: string; text?: string; senderId?: string; senderName?: string | null; messageType?: string; isDeleted?: boolean } | null;
  timestamp: string;
  fromDevice: number;
}

export type Received =
  | { kind: 'message'; message: LocalMessage }
  | { kind: 'edit'; message: LocalMessage }
  | { kind: 'control' } // sender key distribution etc.
  | { kind: 'duplicate'; message?: LocalMessage } // already here (another tab read it, or a resend): our copy
  | { kind: 'waiting' } // can't be read yet (a group key hasn't arrived, or the server is unreachable); keep it for later
  | { kind: 'failed'; error: string };

const DIRECTORY_TTL_MS = 10 * 60 * 1000;

interface GroupDistribution { keyId: number; delivered: string[] }

export class Messenger {
  private cache = new Map<string, { at: number; devices: DevicePublic[] }>();

  constructor(private store: EncryptedStore, private http: E2EHttp, private me: Address) {}

  // ---------------- device directory

  /**
   * Verified devices of a user (from their signed device list). Pins the account key on first sight;
   * if it later changes, the new key is accepted and the change recorded on the pin.
   */
  async devicesOf(user: string, force = false): Promise<DevicePublic[] | null> {
    const hit = this.cache.get(user);
    if (hit && !force && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.devices;
    let list: DeviceList;
    try {
      list = await this.http.get<DeviceList>(`/e2e/v2/users/${user}/device-list`);
    } catch (e) {
      if (httpStatus(e) === 404) return null; // hasn't set up v2
      throw e;
    }
    const pin = await this.store.pin(user);
    const known = await this.store.deviceList(user);
    let devices: DevicePublic[];
    if (pin && pin.aik === list.aik) {
      devices = verifyDeviceList(list, user, undefined, known && known.aik === list.aik ? known.version : undefined);
    } else {
      devices = verifyDeviceList(list, user); // first sight, or a fresh start with a new account key
      await this.store.savePin(user, pin
        // A verified contact's new key must be accepted before we send to them again (docs §3.4)
        ? { aik: list.aik, verified: false, firstSeen: pin.firstSeen, changedAt: Date.now(), previousAik: pin.aik, needsAccept: pin.verified || !!pin.needsAccept }
        : { aik: list.aik, verified: false, firstSeen: Date.now() });
    }
    await this.store.saveDeviceList(user, list);
    this.cache.set(user, { at: Date.now(), devices });
    return devices;
  }

  /** Forget cached device lists (a list changed, or a chat's members changed). */
  forget(user?: string) {
    if (user) this.cache.delete(user);
    else this.cache.clear();
  }

  /** Can this conversation use v2? Every member must have a device list, and this device must be on ours. */
  async ready(members: string[]): Promise<boolean> {
    const lists = await Promise.all(members.map((m) => this.devicesOf(m).catch(() => null)));
    if (lists.some((l) => !l || !l.length)) return false;
    const mine = lists[members.indexOf(this.me.user)];
    return !!mine?.some((d) => d.id === this.me.device);
  }

  /** Every device that should get a message in this conversation, except this one. */
  private async targets(members: string[]): Promise<{ user: string; device: DevicePublic }[]> {
    const out: { user: string; device: DevicePublic }[] = [];
    const lists = await Promise.all(members.map((user) => this.devicesOf(user))); // all at once, then in order
    for (const [n, user] of members.entries()) {
      const devices = lists[n];
      if (!devices) throw new CryptoError('no_session', `${user} hasn't set up encryption v2`);
      if (user !== this.me.user && (await this.store.pin(user))?.needsAccept) {
        throw Object.assign(new CryptoError('identity_changed', 'Their security code changed. Check or accept the new code in the chat before sending.'), { user });
      }
      for (const d of devices) if (!(user === this.me.user && d.id === this.me.device)) out.push({ user, device: d });
    }
    return out;
  }

  private bundle = (user: string, device: number) => () =>
    this.prefetched.get(`${user}:${device}`) ?? this.http.get<PreKeyBundle>(`/e2e/v2/users/${user}/devices/${device}/bundle`);

  // ---------------- sending

  /**
   * Encrypt a message for a conversation. Returns the envelopes to send (in order). The caller stores
   * its own copy of the message (see `rememberSent`).
   */
  async encrypt(conv: string, isGroup: boolean, members: string[], body: MessageBody): Promise<OutgoingEnvelope[]> {
    const targets = await this.targets(members);
    await this.prefetchBundles(targets);
    // One at a time with receiving: both move the same sessions forward
    try {
      return await this.store.transaction((tx) => (isGroup ? this.encryptGroup(tx, conv, targets, body) : this.encryptDirect(tx, conv, targets, body)));
    } finally {
      this.prefetched.clear();
    }
  }

  /**
   * The first message to a device needs its prekey bundle. Fetch them all at once before encrypting
   * (one round trip instead of one per device); only for devices with no usable session, so no
   * one-time prekey is used up needlessly. A device whose session appears meanwhile just doesn't use it.
   */
  private prefetched = new Map<string, Promise<PreKeyBundle>>();
  private async prefetchBundles(targets: { user: string; device: DevicePublic }[]): Promise<void> {
    const needed = await Promise.all(targets.map((t) => needsSession(this.store, { user: t.user, device: t.device.id }, t.device).catch(() => false)));
    targets.forEach((t, n) => {
      if (!needed[n]) return;
      const fetching = this.http.get<PreKeyBundle>(`/e2e/v2/users/${t.user}/devices/${t.device.id}/bundle`);
      fetching.catch(() => undefined); // read (and any error surfaced) by encryptFor when it asks
      this.prefetched.set(`${t.user}:${t.device.id}`, fetching);
    });
  }

  private async encryptDirect(tx: StoreView, conv: string, targets: { user: string; device: DevicePublic }[], body: MessageBody): Promise<OutgoingEnvelope[]> {
    const plaintext = encodeBody(body);
    const out: OutgoingEnvelope[] = [];
    for (const t of targets) {
      const to: Address = { user: t.user, device: t.device.id };
      const e = await encryptFor(tx, to, t.device, plaintext, this.bundle(t.user, t.device.id));
      out.push({ to_user: t.user, to_device: t.device.id, packet: toMessagePacket(conv, this.me, to, e) });
    }
    return out;
  }

  private async encryptGroup(tx: StoreView, conv: string, targets: { user: string; device: DevicePublic }[], body: MessageBody): Promise<OutgoingEnvelope[]> {
    const names = targets.map((t) => `${t.user}:${t.device.id}`);
    let key = await tx.senderKey(conv, this.me);
    let dist = await tx.setting<GroupDistribution>(`skd:${conv}`);
    // A member or device left since our key was handed out, or the key is old: start a new one
    const someoneLeft = !!dist && dist.delivered.some((n) => !names.includes(n));
    if (!key || !dist || dist.keyId !== key.keyId || someoneLeft || needsRotation(key)) {
      key = newSenderKey();
      dist = { keyId: key.keyId, delivered: [] };
    }
    const out: OutgoingEnvelope[] = [];
    // Hand the key (at its current position) to devices that don't have it yet
    const missing = targets.filter((t) => !dist!.delivered.includes(`${t.user}:${t.device.id}`));
    if (missing.length) {
      const skdm = encodeBody({ v: 2, id: `skdm-${key.keyId}-${key.iteration}-${Date.now()}`, conv, ts: Date.now(), kind: 'skdm', skdm: distribution(key) });
      for (const t of missing) {
        const to: Address = { user: t.user, device: t.device.id };
        const e = await encryptFor(tx, to, t.device, skdm, this.bundle(t.user, t.device.id));
        out.push({ to_user: t.user, to_device: t.device.id, packet: toMessagePacket(conv, this.me, to, e) });
      }
    }
    const packet = toGroupPacket(conv, this.me, groupEncrypt(key, conv, senderName(this.me), encodeBody(body)));
    await tx.saveSenderKey(conv, this.me, key);
    await tx.saveSetting(`skd:${conv}`, { keyId: key.keyId, delivered: Array.from(new Set([...dist.delivered, ...missing.map((t) => `${t.user}:${t.device.id}`)])) });
    for (const t of targets) out.push({ to_user: t.user, to_device: t.device.id, packet });
    return out;
  }

  /** Force a new group key on the next message (someone was removed). */
  async resetGroupKey(conv: string): Promise<void> {
    await this.store.saveSetting(`skd:${conv}`, null);
  }

  /** Store our own sent message (the server copy only says "a message was sent"). */
  async rememberSent(message: LocalMessage): Promise<void> {
    await this.store.transaction((tx) => tx.saveMessage(message, true));
  }

  /** The server confirmed our message: link it to the timeline row. */
  async confirmSent(id: string, serverId: string): Promise<LocalMessage | null> {
    return this.store.transaction(async (tx) => {
      const m = await tx.message(id);
      if (!m) return null;
      const updated = { ...m, serverId, status: 'sent' as const };
      await tx.saveMessage(updated, true);
      return updated;
    });
  }

  /** Our copy of a timeline row (null if this device never got it, e.g. sent before it was linked). */
  async byServerId(serverId: string): Promise<LocalMessage | null> {
    return this.store.messageByServerId(serverId);
  }

  // ---------------- receiving

  async receive(envelope: IncomingEnvelope): Promise<Received> {
    try {
      const devices = await this.devicesOf(envelope.from.user);
      let device = devices?.find((d) => d.id === envelope.from.device);
      if (!device) device = (await this.devicesOf(envelope.from.user, true))?.find((d) => d.id === envelope.from.device);
      if (!device) return { kind: 'failed', error: 'Message from a device that is not on the sender\'s list' };
      return envelope.packet.kind === 'skmsg'
        ? await this.receiveGroup(envelope, envelope.packet as GroupPacket)
        : await this.receiveDirect(envelope, envelope.packet as MessagePacket, device);
    } catch (e) {
      // Couldn't fetch the sender's devices (offline, or the phone blocks the app's network in the
      // background): keep the packet for the next try instead of dropping it as unreadable
      if (isTransientHttpError(e)) return { kind: 'waiting' };
      return { kind: 'failed', error: (e as Error).message };
    }
  }

  private async receiveDirect(envelope: IncomingEnvelope, packet: MessagePacket, device: DevicePublic): Promise<Received> {
    if (packet.to.user !== this.me.user || packet.to.device !== this.me.device) return { kind: 'failed', error: 'Not for this device' };
    return this.store.transaction(async (tx) => {
      const { plaintext, commit } = await decryptFrom(tx, envelope.from, device, fromMessagePacket(packet));
      const body = decodeBody(plaintext, packet.conv);
      await commit(); // the message key is used up either way
      return this.apply(tx, body, envelope);
    });
  }

  private async receiveGroup(envelope: IncomingEnvelope, packet: GroupPacket): Promise<Received> {
    return this.store.transaction(async (tx) => {
      const state = await tx.senderKey(packet.conv, envelope.from);
      if (!state || state.keyId !== packet.kid) return { kind: 'waiting' } as Received;
      const { state: next, plaintext } = groupDecrypt(state, packet.conv, senderName(envelope.from), fromGroupPacket(packet));
      const body = decodeBody(plaintext, packet.conv);
      await tx.saveSenderKey(packet.conv, envelope.from, next);
      return this.apply(tx, body, envelope);
    });
  }

  private async apply(tx: StoreView, body: MessageBody, envelope: IncomingEnvelope): Promise<Received> {
    if (body.kind === 'skdm' && body.skdm) {
      await tx.saveSenderKey(body.conv, envelope.from, fromDistribution(body.skdm));
      return { kind: 'control' };
    }
    if (body.kind === 'edit' && body.edit && body.text !== undefined) {
      const original = await tx.message(body.edit.of);
      if (!original || original.sender.user !== envelope.from.user) return { kind: 'failed', error: 'Edit of an unknown message' };
      const edited = await tx.editMessage(body.edit.of, body.edit.rev, body.text, body.ts);
      return edited ? { kind: 'edit', message: edited } : { kind: 'duplicate' };
    }
    if (body.kind !== 'text' && body.kind !== 'media') return { kind: 'control' };
    if (await tx.hasMessage(body.id)) {
      // Our own message coming back to another of our devices, or a replay: link the server id at most
      const existing = (await tx.message(body.id))!;
      const linked = envelope.message_id && !existing.serverId ? { ...existing, serverId: envelope.message_id } : existing;
      if (linked !== existing) await tx.saveMessage(linked, true);
      return { kind: 'duplicate', message: linked };
    }
    const message: LocalMessage = {
      id: body.id, conv: body.conv, sender: envelope.from, ts: body.ts, kind: body.kind,
      text: body.text, media: body.media, replyTo: body.replyTo,
      serverId: envelope.message_id || undefined, status: 'delivered',
    };
    await tx.saveMessage(message);
    return { kind: 'message', message };
  }

  /**
   * Fetch and process everything waiting in this device's mailbox. `onReceived` runs for each result
   * (to update the screen). Packets that can't be read yet are left for the next time.
   */
  async drain(onReceived: (r: Received, envelope: IncomingEnvelope) => void): Promise<void> {
    for (let round = 0; round < 20; round++) {
      const page = await this.http.get<IncomingEnvelope[]>(`/e2e/v2/mailbox/${this.me.device}`);
      if (!page.length) return;
      const done: string[] = [];
      let waiting = 0;
      for (const envelope of page) {
        const r = await this.receive(envelope);
        if (r.kind === 'waiting') waiting += 1;
        else done.push(envelope.id);
        onReceived(r, envelope);
      }
      if (done.length) await this.http.post(`/e2e/v2/mailbox/${this.me.device}/ack`, { ids: done });
      if (waiting === page.length) return; // nothing more can be read right now
    }
  }

  /** Acknowledge one envelope (after a live WebSocket delivery was processed). */
  async ack(ids: string[]): Promise<void> {
    if (ids.length) await this.http.post(`/e2e/v2/mailbox/${this.me.device}/ack`, { ids });
  }

  /**
   * Another device couldn't read one of our messages and asked for it again (a retry request): encrypt
   * our copy once more, for that device only, over a new session (the old one may be what broke), as
   * WhatsApp does. Always a direct packet, also in groups. Null if this device doesn't have the message.
   */
  async resend(serverId: string, to: Address): Promise<OutgoingEnvelope | null> {
    const message = await this.store.messageByServerId(serverId);
    if (!message || message.sender.user !== this.me.user || message.deleted || (message.kind !== 'text' && message.kind !== 'media')) return null;
    const device = (await this.devicesOf(to.user, true))?.find((d) => d.id === to.device);
    if (!device) return null;
    const body: MessageBody = {
      v: 2, id: message.id, conv: message.conv, ts: message.ts, kind: message.kind,
      ...(message.text !== undefined ? { text: message.text } : {}), ...(message.media ? { media: message.media } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    };
    return this.store.transaction(async (tx) => {
      await tx.removeSession(to);
      const e = await encryptFor(tx, to, device, encodeBody(body), this.bundle(to.user, to.device));
      return { to_user: to.user, to_device: to.device, packet: toMessagePacket(message.conv, this.me, to, e) };
    });
  }

  /** For edits: who gets a follow-up to an existing message (same rules as sending). */
  async encryptEdit(conv: string, isGroup: boolean, members: string[], of: string, rev: number, text: string): Promise<OutgoingEnvelope[]> {
    return this.encrypt(conv, isGroup, members, { v: 2, id: `${of}-edit-${rev}`, conv, ts: Date.now(), kind: 'edit', text, edit: { of, rev } });
  }

  /** The account key pinned for a person (for safety numbers and "security code changed"). */
  async pinOf(user: string) {
    return this.store.pin(user);
  }
}

export const isV2Marker = (text: string | null | undefined): boolean => !!text && text.startsWith('e2e2:');
export { b64 as v2b64 };
