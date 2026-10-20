// ShareEven end-to-end encryption v2: building blocks (docs/encryption-design-v2.md).
// Shared word for word by web/src/crypto/v2 and mobile/src/crypto/v2.
//
// X25519 (key agreement), Ed25519 (signatures), HKDF-SHA256 / HMAC-SHA256 (key derivation) and
// ChaCha20-Poly1305 (encryption): constant-time and fast in plain JavaScript, so the same code runs
// in browsers and React Native.
//
// The heavy operations can be swapped for native ones (useFastCrypto): the phone's JavaScript engine
// has no JIT, so a photo's encryption and hashing take seconds in JavaScript and milliseconds
// natively. Same algorithms, same bytes: a native backend only replaces how they're computed.

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, randomBytes } from '@noble/hashes/utils';
import { fromBase64, fromUtf8, toBase64, utf8 } from '../e2e';

export { ed25519, sha256, hkdf, concatBytes, randomBytes, fromBase64, toBase64, utf8, fromUtf8 };

export const ZERO32 = new Uint8Array(32);

/** Streaming SHA-256 (media files are hashed piece by piece). */
export interface Sha256Stream {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

/** Native versions of the heavy operations. Each one must give exactly the bytes the code below does. */
export interface FastCrypto {
  /** ChaCha20-Poly1305 (RFC 8439, 12-byte nonce), ciphertext || 16-byte tag; decrypt throws if it doesn't verify. */
  aeadEncrypt?: (key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ad: Uint8Array) => Uint8Array;
  aeadDecrypt?: (key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array) => Uint8Array;
  sha256?: (data: Uint8Array) => Uint8Array;
  sha256Stream?: () => Sha256Stream;
  /** X25519 shared secret; may throw on a bad public key. */
  x25519?: (priv: Uint8Array, pub: Uint8Array) => Uint8Array;
  /** Ed25519 with a 32-byte seed as the private key, 64-byte signatures. */
  sign?: (priv: Uint8Array, message: Uint8Array) => Uint8Array;
  verify?: (pub: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
}

let fast: FastCrypto = {};

/** Use native operations where given (mobile: v2-platform/fastCrypto.ts); the rest stay in JavaScript. */
export function useFastCrypto(backend: FastCrypto): void {
  fast = { ...backend };
}

/** Which operations run natively now (for logs and tests). */
export const fastCryptoInUse = (): string[] => Object.keys(fast).filter((k) => !!fast[k as keyof FastCrypto]);

/** One-shot SHA-256 (safety numbers, link codes). */
export const hashSha256 = (data: Uint8Array): Uint8Array => (fast.sha256 ? fast.sha256(data) : sha256(data));

/** Streaming SHA-256 (media files). */
export function sha256Stream(): Sha256Stream {
  if (fast.sha256Stream) return fast.sha256Stream();
  const h = sha256.create();
  return { update: (d) => { h.update(d); }, digest: () => h.digest() };
}

export const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

export const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Math.floor(n / 2 ** 32));
  v.setUint32(4, n >>> 0);
  return b;
};

export const eq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

export class CryptoError extends Error {
  constructor(public code: 'invalid_key' | 'bad_signature' | 'decrypt_failed' | 'too_many_skipped' | 'replay' | 'bad_format' | 'no_session' | 'identity_changed', message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

export const newX25519 = (): KeyPair => {
  const priv = x25519.utils.randomPrivateKey();
  return { priv, pub: x25519.getPublicKey(priv) };
};

export const newEd25519 = (): KeyPair => {
  const priv = ed25519.utils.randomPrivateKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
};

export const x25519Public = (priv: Uint8Array): Uint8Array => x25519.getPublicKey(priv);

/** X25519 that refuses low-order points: an all-zero result means the peer sent a bad key. */
export function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  if (pub.length !== 32) throw new CryptoError('invalid_key', 'Bad public key');
  let out: Uint8Array;
  try {
    out = fast.x25519 ? fast.x25519(priv, pub) : x25519.getSharedSecret(priv, pub);
  } catch {
    throw new CryptoError('invalid_key', 'Bad public key');
  }
  if (out.every((b: number) => b === 0)) throw new CryptoError('invalid_key', 'Bad public key');
  return out;
}

export const sign = (priv: Uint8Array, message: Uint8Array): Uint8Array => (fast.sign ? fast.sign(priv, message) : ed25519.sign(message, priv));

export function verify(pub: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return fast.verify ? fast.verify(pub, message, signature) : ed25519.verify(signature, message, pub);
  } catch {
    return false;
  }
}

/** Root chain: HKDF(salt = root key, ikm = DH output) -> (new root key, chain key). */
export function kdfRK(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const okm = hkdf(sha256, dhOut, rk, utf8('PapyrisRatchet.v2'), 64);
  return [okm.slice(0, 32), okm.slice(32)];
}

/** Symmetric chain step: message key = HMAC(ck, 0x01), next chain key = HMAC(ck, 0x02). One-way. */
export function kdfCK(ck: Uint8Array): [next: Uint8Array, mk: Uint8Array] {
  return [hmac(sha256, ck, Uint8Array.of(2)), hmac(sha256, ck, Uint8Array.of(1))];
}

/** A message key becomes a ChaCha20-Poly1305 key and nonce, used exactly once. */
export function messageKeys(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const okm = hkdf(sha256, mk, ZERO32, utf8('PapyrisMessageKeys.v2'), 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

export function seal(mk: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
  const k = messageKeys(mk);
  return aeadEncrypt(k.key, k.nonce, plaintext, ad);
}

export function open(mk: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Uint8Array {
  const k = messageKeys(mk);
  try {
    return aeadDecrypt(k.key, k.nonce, ciphertext, ad);
  } catch {
    throw new CryptoError('decrypt_failed', 'Message could not be decrypted');
  }
}

/** ChaCha20-Poly1305 with an explicit key and nonce (keys used once: link grants, media chunks). */
export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
  return fast.aeadEncrypt ? fast.aeadEncrypt(key, nonce, plaintext, ad) : chacha20poly1305(key, nonce, ad).encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Uint8Array {
  try {
    return fast.aeadDecrypt ? fast.aeadDecrypt(key, nonce, ciphertext, ad) : chacha20poly1305(key, nonce, ad).decrypt(ciphertext);
  } catch {
    throw new CryptoError('decrypt_failed', 'Could not be decrypted');
  }
}

/** Deterministic JSON (sorted keys) for anything that gets signed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const b64 = toBase64;
export const unb64 = fromBase64;
