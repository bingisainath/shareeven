// src/crypto/v2-platform/fastCrypto.ts
// Native crypto for the phone, plugged into crypto/v2 (useFastCrypto in v2/primitives.ts).
//
// Hermes, React Native's JavaScript engine, has no JIT: in plain JavaScript a photo's encryption
// and hashing take seconds on a phone, and each signature check tens of milliseconds. Here the same
// algorithms run in native code (react-native-quick-crypto: OpenSSL), giving the exact same bytes.
//
// Written against Node's crypto API, which react-native-quick-crypto copies, so the tests run it on
// Node's own crypto and check it byte for byte against the JavaScript code. At start every operation
// is checked again on this phone (selfTest), and only the ones that match are switched on: if a
// native library misbehaves on some phone, the app keeps the JavaScript code rather than breaking.

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha2';
import { FastCrypto, Sha256Stream, useFastCrypto } from '../v2/primitives';

/** The part of Node's crypto API used here (react-native-quick-crypto has the same shape). */
export interface NodeLikeCrypto {
  createCipheriv(algorithm: string, key: any, iv: any, options?: any): any;
  createDecipheriv(algorithm: string, key: any, iv: any, options?: any): any;
  createHash(algorithm: string): any;
  createPrivateKey(key: any): any;
  createPublicKey(key: any): any;
  diffieHellman(options: { privateKey: any; publicKey: any }): any;
  sign(algorithm: null, data: any, key: any): any;
  verify(algorithm: null, data: any, key: any, signature: any): boolean;
}

/** Buffer.from-like: Node's Buffer, or the one react-native-quick-crypto ships. */
type ToBuffer = (bytes: Uint8Array) => any;

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
// Raw 32-byte keys wrapped in their standard DER encodings (PKCS#8 private, SubjectPublicKeyInfo public)
const DER = {
  edPriv: fromHex('302e020100300506032b657004220420'),
  edPub: fromHex('302a300506032b6570032100'),
  xPriv: fromHex('302e020100300506032b656e04220420'),
  xPub: fromHex('302a300506032b656e032100'),
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A plain Uint8Array copy of whatever the native call returned (Buffer, ArrayBuffer...). */
const bytes = (v: any): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));

const keyId = (k: Uint8Array) => Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('');

/** Small cache of parsed keys: the same sender's key is checked again and again. */
class KeyCache<V> {
  private map = new Map<string, V>();
  constructor(private limit = 256) {}
  get(k: Uint8Array, make: () => V): V {
    const id = keyId(k);
    const hit = this.map.get(id);
    if (hit !== undefined) return hit;
    const v = make();
    if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value as string);
    this.map.set(id, v);
    return v;
  }
}

export function nodeStyleBackend(c: NodeLikeCrypto, toBuffer: ToBuffer): Required<FastCrypto> {
  const B = toBuffer;
  const edPriv = new KeyCache<any>();
  const edPub = new KeyCache<any>();
  const xPriv = new KeyCache<any>();
  const xPub = new KeyCache<any>();
  const privateKey = (prefix: Uint8Array, raw: Uint8Array) => c.createPrivateKey({ key: B(concat(prefix, raw)), format: 'der', type: 'pkcs8' });
  const publicKey = (prefix: Uint8Array, raw: Uint8Array) => c.createPublicKey({ key: B(concat(prefix, raw)), format: 'der', type: 'spki' });

  return {
    aeadEncrypt(key, nonce, plaintext, ad) {
      const cipher = c.createCipheriv('chacha20-poly1305', B(key), B(nonce), { authTagLength: 16 });
      cipher.setAAD(B(ad), { plaintextLength: plaintext.length });
      const body = concat(bytes(cipher.update(B(plaintext))), bytes(cipher.final()));
      return concat(body, bytes(cipher.getAuthTag()));
    },
    aeadDecrypt(key, nonce, ciphertext, ad) {
      if (ciphertext.length < 16) throw new Error('Too short');
      const body = ciphertext.subarray(0, ciphertext.length - 16);
      const decipher = c.createDecipheriv('chacha20-poly1305', B(key), B(nonce), { authTagLength: 16 });
      decipher.setAAD(B(ad), { plaintextLength: body.length });
      decipher.setAuthTag(B(ciphertext.subarray(ciphertext.length - 16)));
      return concat(bytes(decipher.update(B(body))), bytes(decipher.final())); // final() throws if the tag is wrong
    },
    sha256(data) {
      return bytes(c.createHash('sha256').update(B(data)).digest());
    },
    sha256Stream(): Sha256Stream {
      const h = c.createHash('sha256');
      return { update: (d) => { h.update(B(d)); }, digest: () => bytes(h.digest()) };
    },
    x25519(priv, pub) {
      return bytes(c.diffieHellman({
        privateKey: xPriv.get(priv, () => privateKey(DER.xPriv, priv)),
        publicKey: xPub.get(pub, () => publicKey(DER.xPub, pub)),
      }));
    },
    sign(priv, message) {
      return bytes(c.sign(null, B(message), edPriv.get(priv, () => privateKey(DER.edPriv, priv))));
    },
    verify(pub, message, signature) {
      if (signature.length !== 64 || pub.length !== 32) return false;
      return c.verify(null, B(message), edPub.get(pub, () => publicKey(DER.edPub, pub)), B(signature));
    },
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Check each native operation against the JavaScript one on fixed inputs (and that it rejects what
 * it must). Returns only the operations that passed; anything that throws or differs is left out.
 */
export function selfTest(backend: Required<FastCrypto>): FastCrypto {
  const out: FastCrypto = {};
  const check = (name: keyof FastCrypto, test: () => boolean) => {
    try {
      if (test()) (out as any)[name] = backend[name];
    } catch {
      // left out: the JavaScript version is used
    }
  };
  const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 255);
  const key = seed(1);
  const nonce = seed(2).subarray(0, 12);
  const ad = seed(3).subarray(0, 20);
  const text = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31) & 255);
  const reference = chacha20poly1305(key, nonce, ad).encrypt(text);

  check('aeadEncrypt', () => sameBytes(backend.aeadEncrypt(key, nonce, text, ad), reference));
  check('aeadDecrypt', () => {
    if (!sameBytes(backend.aeadDecrypt(key, nonce, reference, ad), text)) return false;
    const tampered = reference.slice();
    tampered[5] ^= 1;
    try {
      backend.aeadDecrypt(key, nonce, tampered, ad);
      return false; // accepted a changed message
    } catch {
      return true;
    }
  });
  check('sha256', () => sameBytes(backend.sha256(text), sha256(text)));
  check('sha256Stream', () => {
    const h = backend.sha256Stream();
    h.update(text.subarray(0, 333));
    h.update(text.subarray(333));
    return sameBytes(h.digest(), sha256(text));
  });
  const a = seed(4);
  const bPub = x25519.getPublicKey(seed(5));
  check('x25519', () => sameBytes(backend.x25519(a, bPub), x25519.getSharedSecret(a, bPub)));
  const edSeed = seed(6);
  const edPub = ed25519.getPublicKey(edSeed);
  const signature = ed25519.sign(text, edSeed);
  check('sign', () => sameBytes(backend.sign(edSeed, text), signature));
  check('verify', () => {
    const bad = signature.slice();
    bad[0] ^= 1;
    return backend.verify(edPub, text, signature) && !backend.verify(edPub, text, bad) && !backend.verify(edPub, text.subarray(1), signature);
  });
  return out;
}

/**
 * At app start: switch on the native operations that pass the self-test on this phone.
 * Returns their names (logged), or [] when react-native-quick-crypto isn't available.
 */
export function enableFastCrypto(): string[] {
  let qc: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-quick-crypto');
    qc = mod.default || mod;
  } catch {
    return [];
  }
  if (!qc?.createCipheriv) return [];
  const toBuffer: ToBuffer = (b) => qc.Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const passed = selfTest(nodeStyleBackend(qc, toBuffer));
  useFastCrypto(passed);
  const names = Object.keys(passed);
  console.log(`[crypto] native: ${names.join(', ') || 'none'} (the rest in JavaScript)`);
  return names;
}
