// Identities (docs/encryption-design-v2.md §2-3): an account identity key (AIK, Ed25519) that only the
// primary device holds, and per-device identity keys certified by it. Contacts pin the AIK; the safety
// number is computed from AIKs, so linking a device never changes it.

import {
  b64, canonicalJson, concatBytes, CryptoError, KeyPair, newEd25519, newX25519, sha256, sign, u32be, u64be, unb64, utf8, verify, hashSha256,
} from './primitives';

export interface DeviceIdentity {
  sign: KeyPair; // Ed25519
  dh: KeyPair; // X25519, used in X3DH
  dhSig: Uint8Array; // Ed25519(sign, dh.pub): ties the two halves together
}

export function newDeviceIdentity(): DeviceIdentity {
  const signKey = newEd25519();
  const dhKey = newX25519();
  return { sign: signKey, dh: dhKey, dhSig: sign(signKey.priv, dhKey.pub) };
}

export const newAccountIdentity = (): KeyPair => newEd25519();

/** The public half other people see for one device. */
export interface DevicePublic {
  id: number;
  sign: string; // b64 Ed25519
  dh: string; // b64 X25519
  dhSig: string; // b64
  created: number; // ms
  cert: string; // b64 Ed25519(AIK, certBytes)
}

const certBytes = (user: string, id: number, signPub: Uint8Array, dhPub: Uint8Array, created: number) => {
  const u = utf8(user);
  return concatBytes(utf8('PapyrisDeviceCert.v2'), u32be(u.length), u, u32be(id), signPub, dhPub, u64be(created));
};

export function certifyDevice(aikPriv: Uint8Array, user: string, id: number, device: { sign: Uint8Array; dh: Uint8Array; dhSig: Uint8Array }, created = Date.now()): DevicePublic {
  if (!verify(device.sign, device.dh, device.dhSig)) throw new CryptoError('bad_signature', "The device's keys don't belong together");
  return {
    id, sign: b64(device.sign), dh: b64(device.dh), dhSig: b64(device.dhSig), created,
    cert: b64(sign(aikPriv, certBytes(user, id, device.sign, device.dh, created))),
  };
}

export function verifyDevice(aikPub: Uint8Array, user: string, d: DevicePublic): boolean {
  const signPub = unb64(d.sign);
  const dhPub = unb64(d.dh);
  return verify(signPub, dhPub, unb64(d.dhSig)) && verify(aikPub, certBytes(user, d.id, signPub, dhPub, d.created), unb64(d.cert));
}

/** The account's devices, signed by the AIK. The version only goes up, so an old list can't be replayed. */
export interface DeviceList {
  user: string;
  aik: string; // b64: who signed it
  version: number;
  devices: DevicePublic[];
  sig: string; // b64 Ed25519(AIK, 'PapyrisDeviceList.v2' || canonical JSON without sig)
}

const listBytes = (list: Omit<DeviceList, 'sig'>) => utf8(`PapyrisDeviceList.v2${canonicalJson(list)}`);

export function signDeviceList(aik: KeyPair, user: string, version: number, devices: DevicePublic[]): DeviceList {
  const unsigned = { user, aik: b64(aik.pub), version, devices };
  return { ...unsigned, sig: b64(sign(aik.priv, listBytes(unsigned))) };
}

/**
 * Check a device list against the account key we pinned for this user (or accept it as the first
 * one we see). Returns the devices that are properly certified. Throws if the list is forged.
 */
export function verifyDeviceList(list: DeviceList, expectedUser: string, pinnedAik?: Uint8Array, lastVersion?: number): DevicePublic[] {
  if (list.user !== expectedUser) throw new CryptoError('bad_signature', 'Device list is for someone else');
  const aik = unb64(list.aik);
  if (pinnedAik && b64(pinnedAik) !== list.aik) throw new CryptoError('bad_signature', 'Signed by a different account key');
  const { sig, ...unsigned } = list;
  if (!verify(aik, listBytes(unsigned), unb64(sig))) throw new CryptoError('bad_signature', 'Device list signature is invalid');
  if (lastVersion !== undefined && list.version < lastVersion) throw new CryptoError('replay', 'Older device list than one already seen');
  const ids = new Set<number>();
  return list.devices.filter((d) => {
    if (ids.has(d.id)) return false;
    ids.add(d.id);
    return verifyDevice(aik, list.user, d);
  });
}

/**
 * Safety number for two accounts (60 digits), like Signal's: both people see the same digits when
 * the server handed out the right account keys.
 */
export function safetyNumber(a: { user: string; aik: Uint8Array }, b: { user: string; aik: Uint8Array }): string {
  const part = (p: { user: string; aik: Uint8Array }) => {
    let hash = hashSha256(concatBytes(utf8('PapyrisSafetyNumber.v2'), utf8(p.user), p.aik));
    for (let i = 0; i < 5199; i++) hash = hashSha256(concatBytes(hash, p.aik)); // slow to search for collisions, like Signal's 5200 iterations
    let digits = '';
    for (let i = 0; i < 30; i += 5) {
      const n = (hash[i] * 2 ** 32 + hash[i + 1] * 2 ** 24 + hash[i + 2] * 2 ** 16 + hash[i + 3] * 2 ** 8 + hash[i + 4]) % 100000;
      digits += String(n).padStart(5, '0');
    }
    return digits;
  };
  const [first, second] = [a, b].sort((x, y) => (x.user < y.user ? -1 : 1));
  return (part(first) + part(second)).replace(/(\d{5})/g, '$1 ').trim();
}

// ---- storage form (base64 JSON) for keys kept on the device

export interface StoredKeyPair { priv: string; pub: string }
export const storeKeyPair = (k: KeyPair): StoredKeyPair => ({ priv: b64(k.priv), pub: b64(k.pub) });
export const loadKeyPair = (k: StoredKeyPair): KeyPair => ({ priv: unb64(k.priv), pub: unb64(k.pub) });

export interface StoredDeviceIdentity { sign: StoredKeyPair; dh: StoredKeyPair; dhSig: string }
export const storeDeviceIdentity = (d: DeviceIdentity): StoredDeviceIdentity => ({ sign: storeKeyPair(d.sign), dh: storeKeyPair(d.dh), dhSig: b64(d.dhSig) });
export const loadDeviceIdentity = (d: StoredDeviceIdentity): DeviceIdentity => ({ sign: loadKeyPair(d.sign), dh: loadKeyPair(d.dh), dhSig: unb64(d.dhSig) });
