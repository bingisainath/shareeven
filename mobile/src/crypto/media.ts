// src/crypto/media.ts
// End-to-end encrypted photos, videos, voice notes and documents on the phone.
//
// Files are encrypted before upload and decrypted after download in 64 KiB pieces, streamed
// to and from the app's cache folder, so a 50 MB video never has to fit in memory at once.
// Decrypted copies are kept in the cache (named by a hash of the file's address and key) so
// photos don't download again every time a chat opens; the phone clears that cache when short
// on space.

import { useEffect, useState } from 'react';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { sha256 } from '@noble/hashes/sha2';
import {
  FILE_CHUNK, FILE_HEADER, FileDecryptor, FileEncryptor, fromBase64 as jsFromBase64, jpegOrientation, newFileKey, stripJpegMetadata,
  toBase64 as jsToBase64, utf8,
} from './e2e';
import { mediaUrl } from '../config';
import { encryptMedia, MediaDecryptor, MediaEncryptor } from './v2/media';

/** v2 files (PMV2 format) also carry the hash and real size from their pointer. */
export interface V2File { sha256: string; size: number }

const fs = ReactNativeBlobUtil.fs;

/**
 * Files move between JavaScript and the file system as base64, megabytes at a time: native base64
 * (react-native-quick-base64) when it's there and gives the same result, else the JavaScript one.
 */
const base64 = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const q = require('react-native-quick-base64');
    const sample = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 255);
    const text = q.fromByteArray(sample);
    const back: Uint8Array = q.toByteArray(text);
    if (text === jsToBase64(sample) && back.length === sample.length && back.every((b, i) => b === sample[i])) {
      return { from: (t: string): Uint8Array => q.toByteArray(t), to: (b: Uint8Array): string => q.fromByteArray(b) };
    }
  } catch {
    // not in this build (tests, web): JavaScript
  }
  return { from: jsFromBase64, to: jsToBase64 };
})();
const fromBase64 = (t: string) => base64.from(t);
const toBase64 = (b: Uint8Array) => base64.to(b);

/**
 * At most two files are downloaded and decrypted at once, the newest request first (what's on the
 * screen now): a chat full of photos then stays smooth instead of starting everything together.
 */
const MAX_DECRYPTING = 2;
let decrypting = 0;
const waiting: (() => void)[] = [];
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (decrypting >= MAX_DECRYPTING) await new Promise<void>((go) => waiting.push(go));
  decrypting += 1;
  try {
    return await work();
  } finally {
    decrypting -= 1;
    waiting.pop()?.(); // newest first
  }
}
const DIR = `${fs.dirs.CacheDir}/e2e`;
const TAG = 16;
const SMALL = 8 * 1024 * 1024; // up to this size, a file is processed in one go

const plainPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function ensureDir() {
  if (!(await fs.isDir(DIR))) await fs.mkdir(DIR).catch(() => undefined);
}

/**
 * Read a file in pieces of exactly `size` bytes (the last may be shorter), handing each to `handle`
 * in order; `handle` gets `last` = true for the final piece. The first `skip` bytes go to `onSkipped`
 * instead (an encrypted file's header).
 */
async function readPieces(
  path: string, size: number, skip: number, handle: (piece: Uint8Array, last: boolean) => Promise<void>,
  onSkipped?: (bytes: Uint8Array) => void,
) {
  const total = (await fs.stat(path)).size;
  let pending = new Uint8Array(0);
  let consumed = 0; // bytes of the file handed out so far (after skip)
  let skipped = 0;
  const head = new Uint8Array(skip);
  let chain = Promise.resolve();
  const stream = await fs.readStream(path, 'base64', 3 * 21845); // a multiple of 3: no padding mid-file
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (e: unknown) => {
      if (!failed) {
        failed = true;
        reject(e);
      }
    };
    stream.onData((chunk) => {
      chain = chain.then(async () => {
        if (failed) return;
        let bytes = fromBase64(chunk as string);
        if (skipped < skip) {
          const drop = Math.min(skip - skipped, bytes.length);
          head.set(bytes.subarray(0, drop), skipped);
          skipped += drop;
          bytes = bytes.subarray(drop);
          if (skipped === skip) onSkipped?.(head);
        }
        const merged = new Uint8Array(pending.length + bytes.length);
        merged.set(pending);
        merged.set(bytes, pending.length);
        let offset = 0;
        while (merged.length - offset >= size && consumed + size < total - skip) {
          await handle(merged.subarray(offset, offset + size), false);
          offset += size;
          consumed += size;
        }
        pending = merged.slice(offset);
      }).catch(fail);
    });
    stream.onError(fail);
    stream.onEnd(() => {
      chain = chain.then(async () => {
        if (!failed) await handle(pending, true);
      }).then(resolve, fail);
    });
    stream.open();
  });
}

/** Encrypt a local file for upload. Returns the encrypted file (in the cache) and its key. */
export async function encryptForUpload(file: { uri: string; type: string }): Promise<{ uri: string; key: string; size: number }> {
  await ensureDir();
  const key = newFileKey();
  const source = plainPath(file.uri);
  const target = `${DIR}/up-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`;
  const encryptor = new FileEncryptor(key);
  const { size } = await fs.stat(source);

  if (size <= SMALL) {
    let data = fromBase64(await fs.readFile(source, 'base64'));
    // Photos keep no location/camera data (only stripped when already upright, so they don't turn sideways)
    if (file.type === 'image/jpeg' && jpegOrientation(data) === 1) data = stripJpegMetadata(data);
    const parts: Uint8Array[] = [encryptor.header()];
    if (data.length === 0) parts.push(encryptor.push(data, true));
    for (let offset = 0; offset < data.length; offset += FILE_CHUNK) {
      const end = Math.min(offset + FILE_CHUNK, data.length);
      parts.push(encryptor.push(data.subarray(offset, end), end === data.length));
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    await fs.writeFile(target, toBase64(out), 'base64');
    return { uri: `file://${target}`, key: toBase64(key), size: data.length };
  }

  const writer = await fs.writeStream(target, 'base64', false);
  try {
    await writer.write(toBase64(encryptor.header()));
    await readPieces(source, FILE_CHUNK, 0, async (piece, last) => {
      await writer.write(toBase64(encryptor.push(piece, last)));
    });
  } finally {
    await writer.close();
  }
  return { uri: `file://${target}`, key: toBase64(key), size };
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'weba', 'audio/ogg': 'ogg',
  'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * Encrypt a local file in the v2 (PMV2) format for upload, streaming from disk.
 * Returns the encrypted file and what goes in the media pointer.
 */
export async function encryptFileV2(file: { uri: string; type: string }): Promise<{ uri: string; key: string; sha256: string; size: number }> {
  await ensureDir();
  const source = plainPath(file.uri);
  const target = `${DIR}/up2-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`;
  const { size } = await fs.stat(source);
  const started = Date.now();
  const timing = () => console.log(`[media] ${(Number(size) / 1e6).toFixed(2)} MB: encrypted in ${Date.now() - started} ms`);
  if (size <= SMALL) {
    let data = fromBase64(await fs.readFile(source, 'base64'));
    if (file.type === 'image/jpeg' && jpegOrientation(data) === 1) data = stripJpegMetadata(data);
    const sealed = encryptMedia(data);
    await fs.writeFile(target, toBase64(sealed.blob), 'base64');
    timing();
    return { uri: `file://${target}`, key: sealed.key, sha256: sealed.sha256, size: sealed.size };
  }
  const encryptor = new MediaEncryptor();
  const writer = await fs.writeStream(target, 'base64', false);
  let done: ReturnType<MediaEncryptor['finish']>;
  try {
    await writer.write(toBase64(encryptor.start()));
    await readPieces(source, FILE_CHUNK, 0, async (piece) => {
      for (const c of encryptor.push(piece)) await writer.write(toBase64(c));
    });
    done = encryptor.finish();
    for (const c of done.chunks) await writer.write(toBase64(c));
  } finally {
    await writer.close();
  }
  timing();
  return { uri: `file://${target}`, key: done.key, sha256: done.sha256, size: done.size };
}

const inFlight = new Map<string, Promise<string>>();
/**
 * Files already decrypted (or our own, just sent), by cache id: shown on a bubble's first frame.
 * Without it, a sent photo blinked when its bubble became the server's copy, and every reopened
 * chat showed placeholders while each photo was looked up on disk.
 */
const ready = new Map<string, string>();
const MAX_READY = 500;
const markReady = (id: string, uri: string) => {
  ready.delete(id);
  ready.set(id, uri);
  if (ready.size > MAX_READY) ready.delete(ready.keys().next().value as string);
};
const cacheId = (url: string, key: string) => hex(sha256(utf8(`${url.split('?')[0]}#${key}`))).slice(0, 32);

/** A file on this phone (the copy being sent), not a server address. */
const isLocalFile = (url: string) => /^(file|content):\/\//.test(url);

/**
 * Download an encrypted file, decrypt it into the cache and return its file:// URI.
 * The same file (address + key) is only downloaded and decrypted once.
 */
export function decryptedFile(url: string, key: string, mime?: string, v2?: V2File): Promise<string> {
  // Our own photo while it's being sent: the plain local copy, nothing to download or decrypt
  if (isLocalFile(url)) return Promise.resolve(url);
  const id = cacheId(url, key);
  const existing = inFlight.get(id);
  if (existing) return existing;
  const work = (async () => {
    await ensureDir();
    const target = `${DIR}/${id}.${EXT[mime || ''] || 'bin'}`;
    if (await fs.exists(target)) return `file://${target}`; // decrypted before: no waiting in line
    return inTurn(() => downloadAndDecrypt(url, key, target, id, v2));
  })();
  inFlight.set(id, work);
  work.then((uri) => { if (!ready.has(id)) markReady(id, uri); }, () => inFlight.delete(id));
  return work;
}

async function downloadAndDecrypt(url: string, key: string, target: string, id: string, v2?: V2File): Promise<string> {
  const started = Date.now();
  const download = `${DIR}/${id}.download`;
  const response = await ReactNativeBlobUtil.config({ path: download }).fetch('GET', mediaUrl(url)!);
  if (response.info().status !== 200) {
    await fs.unlink(download).catch(() => undefined);
    throw new Error(`Download failed (${response.info().status})`);
  }
  const downloaded = Date.now();
  const timing = async () => {
    const size = await fs.stat(target).then((st) => Number(st.size)).catch(() => 0);
    console.log(`[media] ${(size / 1e6).toFixed(2)} MB: downloaded in ${downloaded - started} ms, decrypted in ${Date.now() - downloaded} ms`);
  };
  const partial = `${target}.part`;
  if (v2) {
    // PMV2: the decryptor finds the header and the last chunk itself, and checks the hash
    try {
      const decryptor = new MediaDecryptor({ key, sha256: v2.sha256, size: v2.size });
      const writer = await fs.writeStream(partial, 'base64', false);
      try {
        await readPieces(download, FILE_CHUNK, 0, async (piece) => {
          for (const p of decryptor.push(piece)) if (p.length) await writer.write(toBase64(p));
        });
        for (const p of decryptor.finish()) if (p.length) await writer.write(toBase64(p));
      } finally {
        await writer.close();
      }
      await fs.mv(partial, target);
      await timing();
      return `file://${target}`;
    } catch (e) {
      await fs.unlink(partial).catch(() => undefined);
      throw e;
    } finally {
      await fs.unlink(download).catch(() => undefined);
    }
  }
  try {
    let decryptor: FileDecryptor | null = null;
    const writer = await fs.writeStream(partial, 'base64', false);
    try {
      await readPieces(download, FILE_CHUNK + TAG, FILE_HEADER, async (piece, last) => {
        if (!decryptor) throw new Error('File too short');
        const plain = decryptor.push(piece, last);
        if (plain.length) await writer.write(toBase64(plain));
      }, (header) => {
        decryptor = new FileDecryptor(fromBase64(key), header);
      });
    } finally {
      await writer.close();
    }
    await fs.mv(partial, target);
    await timing();
    return `file://${target}`;
  } catch (e) {
    await fs.unlink(partial).catch(() => undefined);
    throw e;
  } finally {
    await fs.unlink(download).catch(() => undefined);
  }
}

/** We just encrypted and uploaded this file ourselves: show it from the local copy instead of downloading. */
export async function rememberDecrypted(url: string, key: string, localUri: string, mime?: string): Promise<void> {
  const id = cacheId(url, key);
  // The bubble keeps showing the very file it showed while sending: same address, so no reload or blink
  markReady(id, localUri);
  await ensureDir();
  const target = `${DIR}/${id}.${EXT[mime || ''] || 'bin'}`;
  await fs.cp(plainPath(localUri), target).catch((e) => {
    // Not fatal: the file is downloaded and decrypted instead. Logged to find "Couldn't decrypt" reports.
    console.warn(`[media] couldn't keep a local copy of ${localUri}:`, e?.message || e);
  });
}

/**
 * The URI to show a media file: the server address for plain media, or a decrypted local copy
 * for encrypted media (undefined while it downloads). `failed` if it couldn't be decrypted.
 */
export function useMediaSrc(url?: string, key?: string, mime?: string, v2?: V2File): { src?: string; failed: boolean } {
  const [state, setState] = useState<{ src?: string; failed: boolean; for?: string }>({ failed: false });
  const id = url && key ? `${url.split('?')[0]}#${key}` : undefined;
  const known = url && key && !isLocalFile(url) ? ready.get(cacheId(url, key)) : undefined;

  useEffect(() => {
    if (!url || !key || isLocalFile(url) || known) return;
    let alive = true;
    decryptedFile(url, key, mime, v2)
      .then((src) => alive && setState({ src, failed: false, for: id }))
      .catch((e) => {
        console.warn(`[media] couldn't show ${url.split('?')[0]} (${mime || 'no type'}, ${v2 ? 'v2' : 'v1'}):`, e?.message || e);
        if (alive) setState({ failed: true, for: id });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, mime, id, v2?.sha256, known]);

  if (!url) return { failed: false };
  if (!key || isLocalFile(url)) return { src: isLocalFile(url) ? url : mediaUrl(url), failed: false };
  if (known) return { src: known, failed: false };
  return state.for === id ? { src: state.src, failed: state.failed } : { failed: false };
}

/**
 * Keep the phone's storage in check (at app start): decrypted media nobody opened for 30 days is
 * removed (it's downloaded and decrypted again if opened), and copies of files shared in from other
 * apps after 2 days (they've been sent or dropped by then).
 */
export async function pruneCaches(now = Date.now()): Promise<number> {
  const rules = [{ dir: DIR, maxAgeMs: 30 * 86_400_000 }, { dir: `${fs.dirs.CacheDir}/shared`, maxAgeMs: 2 * 86_400_000 }];
  let removed = 0;
  for (const { dir, maxAgeMs } of rules) {
    if (!(await fs.isDir(dir).catch(() => false))) continue;
    const files = await fs.lstat(dir).catch(() => []);
    for (const f of files) {
      if (f.type === 'file' && now - Number(f.lastModified) > maxAgeMs && !inFlight.has(f.filename.split('.')[0])) {
        await fs.unlink(f.path).then(() => { removed += 1; }).catch(() => undefined);
      }
    }
  }
  return removed;
}
