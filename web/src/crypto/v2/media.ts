// Encrypted attachments (docs/encryption-design-v2.md §7): photos, videos, voice notes, documents,
// thumbnails and history bundles all use the same "PMV2" format.
//
//   header (16 bytes): "PMV2" | version 2 | flags (bit0 padded) | chunk size u32be | 6 zero bytes
//   chunk_i: ChaCha20-Poly1305(K, nonce_i, AAD = header) of up to 64 KiB, + 16-byte tag
//   K = HKDF(fileKey, "PapyrisMedia.v2"); nonce_i = u64be(i) || 000000 || last
//
// Numbered chunks with a final flag (the STREAM construction) can't be reordered or cut short; any
// chunk decrypts on its own, so videos can seek. Sizes are padded (Padmé) so they leak little.

import { aeadDecrypt, aeadEncrypt, b64, CryptoError, eq, hkdf, randomBytes, sha256, sha256Stream, u64be, unb64, utf8, ZERO32 } from './primitives';

export const MEDIA_CHUNK = 64 * 1024;
export const MEDIA_HEADER = 16;
const TAG = 16;

export interface MediaPointer {
  url: string;
  key: string; // b64 32, random per file
  sha256: string; // b64 32, of the whole encrypted blob
  size: number; // real size before padding
  mime: string;
  type?: 'image' | 'video' | 'audio' | 'file'; // how to show it (a photo sent "as a document" is a file)
  name?: string;
  w?: number;
  h?: number;
  dur?: number;
  blur?: string; // tiny preview (images), b64
  wave?: string; // voice-note waveform, b64
  thumb?: Omit<MediaPointer, 'thumb'>;
}

/** Padmé padding: a size with few significant bits, at most ~12% bigger. */
export function padme(len: number): number {
  if (len < 2) return len;
  const e = Math.floor(Math.log2(len));
  const s = Math.floor(Math.log2(e)) + 1;
  const mask = 2 ** (e - s) - 1;
  return Math.ceil((len + mask) / (mask + 1)) * (mask + 1);
}

export function mediaHeader(padded = true, chunk = MEDIA_CHUNK): Uint8Array {
  const h = new Uint8Array(MEDIA_HEADER);
  h.set(utf8('PMV2'));
  h[4] = 2;
  h[5] = padded ? 1 : 0;
  new DataView(h.buffer).setUint32(6, chunk);
  return h;
}

function parseHeader(h: Uint8Array): { chunk: number } {
  if (h.length < MEDIA_HEADER || h[0] !== 0x50 || h[1] !== 0x4d || h[2] !== 0x56 || h[3] !== 0x32 || h[4] !== 2) {
    throw new CryptoError('bad_format', 'Unknown file format');
  }
  const chunk = new DataView(h.buffer, h.byteOffset, MEDIA_HEADER).getUint32(6);
  if (chunk < 1024 || chunk > 4 * 1024 * 1024) throw new CryptoError('bad_format', 'Bad chunk size');
  return { chunk };
}

const contentKey = (fileKey: Uint8Array) => hkdf(sha256, fileKey, ZERO32, utf8('PapyrisMedia.v2'), 32);

function chunkNonce(i: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  n.set(u64be(i));
  n[11] = last ? 1 : 0;
  return n;
}

/** Size of the encrypted blob for a plaintext of `size` bytes (after padding). */
export const encryptedMediaSize = (size: number): number => {
  const padded = padme(size);
  return MEDIA_HEADER + padded + TAG * Math.max(1, Math.ceil(padded / MEDIA_CHUNK));
};

/**
 * Streaming encryption. Push plaintext in any piece sizes; it emits whole encrypted chunks.
 * finish() pads, seals the final chunk and returns the pointer data (key, hash, size).
 */
export class MediaEncryptor {
  readonly fileKey = randomBytes(32);
  private key = contentKey(this.fileKey);
  private header = mediaHeader(true);
  private buffer = new Uint8Array(0);
  private index = 0;
  private plainSize = 0;
  private hash = sha256Stream();

  start(): Uint8Array {
    this.hash.update(this.header);
    return this.header;
  }

  push(piece: Uint8Array): Uint8Array[] {
    this.plainSize += piece.length;
    const merged = new Uint8Array(this.buffer.length + piece.length);
    merged.set(this.buffer);
    merged.set(piece, this.buffer.length);
    const out: Uint8Array[] = [];
    let offset = 0;
    // keep at least one byte back: the final chunk must be sealed with the "last" flag
    while (merged.length - offset > MEDIA_CHUNK) {
      out.push(this.seal(merged.subarray(offset, offset + MEDIA_CHUNK), false));
      offset += MEDIA_CHUNK;
    }
    this.buffer = merged.slice(offset);
    return out;
  }

  finish(): { chunks: Uint8Array[]; key: string; sha256: string; size: number } {
    // Padmé padding of the whole plaintext, appended as zeros before the last chunk(s)
    let rest = this.buffer;
    const padBytes = padme(this.plainSize) - this.plainSize;
    if (padBytes) {
      const padded = new Uint8Array(rest.length + padBytes);
      padded.set(rest);
      rest = padded;
    }
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (rest.length - offset > MEDIA_CHUNK) {
      chunks.push(this.seal(rest.subarray(offset, offset + MEDIA_CHUNK), false));
      offset += MEDIA_CHUNK;
    }
    chunks.push(this.seal(rest.subarray(offset), true));
    return { chunks, key: b64(this.fileKey), sha256: b64(this.hash.digest()), size: this.plainSize };
  }

  private seal(plain: Uint8Array, last: boolean): Uint8Array {
    const c = aeadEncrypt(this.key, chunkNonce(this.index++, last), plain, this.header);
    this.hash.update(c);
    return c;
  }
}

/** Streaming decryption of a whole blob, in order. Verifies the hash at the end. */
export class MediaDecryptor {
  private key: Uint8Array;
  private header: Uint8Array | null = null;
  private chunk = MEDIA_CHUNK;
  private buffer = new Uint8Array(0);
  private index = 0;
  private written = 0;
  private hash = sha256Stream();

  constructor(private pointer: { key: string; sha256: string; size: number }) {
    this.key = contentKey(unb64(pointer.key));
  }

  /** Feed encrypted bytes in any piece sizes; returns plaintext ready so far (never past the real size). */
  push(piece: Uint8Array): Uint8Array[] {
    this.hash.update(piece);
    let data = piece;
    if (!this.header) {
      const merged = new Uint8Array(this.buffer.length + data.length);
      merged.set(this.buffer);
      merged.set(data, this.buffer.length);
      if (merged.length < MEDIA_HEADER) {
        this.buffer = merged;
        return [];
      }
      this.header = merged.slice(0, MEDIA_HEADER);
      this.chunk = parseHeader(this.header).chunk;
      this.buffer = new Uint8Array(0);
      data = merged.subarray(MEDIA_HEADER);
    }
    const merged = new Uint8Array(this.buffer.length + data.length);
    merged.set(this.buffer);
    merged.set(data, this.buffer.length);
    const step = this.chunk + TAG;
    const out: Uint8Array[] = [];
    let offset = 0;
    while (merged.length - offset > step) { // the final chunk is decided in finish()
      out.push(this.open(merged.subarray(offset, offset + step), false));
      offset += step;
    }
    this.buffer = merged.slice(offset);
    return out;
  }

  finish(): Uint8Array[] {
    if (!this.header || this.buffer.length < TAG) throw new CryptoError('decrypt_failed', 'File is incomplete');
    const last = this.open(this.buffer, true);
    if (!eq(this.hash.digest(), unb64(this.pointer.sha256))) throw new CryptoError('decrypt_failed', 'File was changed');
    return [last];
  }

  private open(c: Uint8Array, last: boolean): Uint8Array {
    const plain = aeadDecrypt(this.key, chunkNonce(this.index++, last), c, this.header!);
    const keep = Math.max(0, Math.min(plain.length, this.pointer.size - this.written)); // drop padding
    this.written += keep;
    return plain.subarray(0, keep);
  }
}

/** Decrypt one chunk on its own (seeking in a video): needs the header and the total chunk count. */
export function decryptMediaChunk(pointer: { key: string }, header: Uint8Array, index: number, chunkCount: number, ciphertext: Uint8Array): Uint8Array {
  parseHeader(header);
  return aeadDecrypt(contentKey(unb64(pointer.key)), chunkNonce(index, index === chunkCount - 1), ciphertext, header);
}

/** Whole-buffer helpers (small files, tests). */
export function encryptMedia(plain: Uint8Array): { blob: Uint8Array; key: string; sha256: string; size: number } {
  const enc = new MediaEncryptor();
  const parts = [enc.start(), ...enc.push(plain)];
  const done = enc.finish();
  parts.push(...done.chunks);
  const blob = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    blob.set(p, o);
    o += p.length;
  }
  return { blob, key: done.key, sha256: done.sha256, size: done.size };
}

export function decryptMedia(blob: Uint8Array, pointer: { key: string; sha256: string; size: number }): Uint8Array {
  const dec = new MediaDecryptor(pointer);
  const parts = [...dec.push(blob), ...dec.finish()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
