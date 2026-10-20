/**
 * The native backend (run here on Node's crypto, whose API react-native-quick-crypto copies) must give
 * exactly the bytes of the JavaScript code, and reject what it rejects.
 */
// Node's crypto (Jest runs on Node; the app's TypeScript setup has no Node types)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha2';
import { nodeStyleBackend, selfTest } from './fastCrypto';
import { fastCryptoInUse, open, seal, useFastCrypto } from '../v2/primitives';
import { decryptMedia, encryptMedia } from '../v2/media';

// Node's Buffer (the app's TypeScript setup has no Node types)
const Buffer = (globalThis as any).Buffer;
// Node's generator: no 64 KB limit like getRandomValues
const randomBytes = (n: number) => new Uint8Array(nodeCrypto.randomBytes(n));
const toBuffer = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
const backend = nodeStyleBackend(nodeCrypto as any, toBuffer);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

afterEach(() => useFastCrypto({}));

test('every operation passes the start-up self-test', () => {
  expect(Object.keys(selfTest(backend)).sort()).toEqual(['aeadDecrypt', 'aeadEncrypt', 'sha256', 'sha256Stream', 'sign', 'verify', 'x25519']);
});

test('ChaCha20-Poly1305 gives the same bytes at every size, and rejects any change', () => {
  for (const size of [0, 1, 15, 16, 17, 255, 1000, 64 * 1024, 64 * 1024 + 17]) {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const ad = randomBytes(size % 50);
    const text = randomBytes(size);
    const js = chacha20poly1305(key, nonce, ad).encrypt(text);
    expect(same(backend.aeadEncrypt(key, nonce, text, ad), js)).toBe(true);
    expect(same(backend.aeadDecrypt(key, nonce, js, ad), text)).toBe(true);
    const changed = js.slice();
    changed[changed.length - 1] ^= 1;
    expect(() => backend.aeadDecrypt(key, nonce, changed, ad)).toThrow();
    expect(() => backend.aeadDecrypt(key, nonce, js, randomBytes(3))).toThrow(); // other associated data
  }
});

test('SHA-256 in one go and in pieces', () => {
  const data = randomBytes(300_000);
  expect(same(backend.sha256(data), sha256(data))).toBe(true);
  const h = backend.sha256Stream();
  for (let at = 0; at < data.length; at += 70_001) h.update(data.subarray(at, at + 70_001));
  expect(same(h.digest(), sha256(data))).toBe(true);
});

test('X25519 and Ed25519 match, with keys reused from the cache', () => {
  for (let i = 0; i < 20; i++) {
    const a = x25519.utils.randomPrivateKey();
    const b = x25519.getPublicKey(x25519.utils.randomPrivateKey());
    expect(same(backend.x25519(a, b), x25519.getSharedSecret(a, b))).toBe(true);
    expect(same(backend.x25519(a, b), x25519.getSharedSecret(a, b))).toBe(true); // cached keys
    const seed = ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(seed);
    const msg = randomBytes(i * 13);
    const sig = ed25519.sign(msg, seed);
    expect(same(backend.sign(seed, msg), sig)).toBe(true);
    expect(backend.verify(pub, msg, sig)).toBe(true);
    expect(backend.verify(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()), msg, sig)).toBe(false); // someone else's key
    expect(backend.verify(pub, msg, sig.subarray(1))).toBe(false); // wrong length
  }
});

test('messages and files cross over between native and JavaScript', () => {
  const mk = randomBytes(32);
  const ad = randomBytes(40);
  const text = randomBytes(500);
  const sealedJs = seal(mk, text, ad);
  useFastCrypto(selfTest(backend));
  expect(fastCryptoInUse().length).toBe(7);
  expect(same(open(mk, sealedJs, ad), text)).toBe(true); // JS-sealed, natively opened
  const sealedNative = seal(mk, text, ad);
  const photo = randomBytes(200_000);
  const encrypted = encryptMedia(photo); // native
  useFastCrypto({});
  expect(same(open(mk, sealedNative, ad), text)).toBe(true); // natively sealed, JS-opened
  expect(same(decryptMedia(encrypted.blob, encrypted), photo)).toBe(true); // a file from a phone, read on the web
});

test('a backend that gets something wrong is switched off for that operation only', () => {
  const broken = { ...backend, sha256: () => new Uint8Array(32), verify: () => true };
  const passed = selfTest(broken);
  expect(passed.sha256).toBeUndefined();
  expect(passed.verify).toBeUndefined(); // accepted a bad signature
  expect(passed.aeadEncrypt).toBeDefined();
});
