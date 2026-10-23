// src/crypto/media.ts
// End-to-end encrypted photos, videos, voice notes and documents in the browser.
// Uploads are encrypted before they leave the page; downloads are decrypted into local blob URLs.

import { useEffect, useState } from 'react';
import { decryptFile, encryptFile, fromBase64, jpegOrientation, newFileKey, stripJpegMetadata, toBase64 } from './e2e';
import { decryptMedia } from './v2/media';
import { resolveMediaUrl, withExtension } from '../utils/media';
import { withDownloadToast } from '../utils/downloadToast';

/** v2 files (PMV2 format) also carry the hash and real size from their pointer. */
export interface V2File { sha256: string; size: number }

/** Encrypt a file for upload. Returns the opaque file to upload and its key (goes inside the message). */
export async function encryptForUpload(file: Blob): Promise<{ file: File; key: string }> {
  const key = newFileKey();
  let data = new Uint8Array(await file.arrayBuffer());
  // Photos sent as documents aren't re-drawn, so drop their location/camera data here.
  // (Only when upright already: rotated photos keep their EXIF so they don't display sideways.)
  if (file.type === 'image/jpeg' && jpegOrientation(data) === 1) data = stripJpegMetadata(data);
  const encrypted = encryptFile(key, data);
  return { file: new File([encrypted], 'file.enc', { type: 'application/octet-stream' }), key: toBase64(key) };
}

// Decrypted files by (URL without its daily signature) + key -> object URL
const objectUrls = new Map<string, Promise<string>>();
// The same, once ready: lets a reopened chat show its photos on the first frame, not a placeholder
const readyUrls = new Map<string, string>();
const MAX_OBJECT_URLS = 150;

const cacheKey = (url: string, key: string) => `${url.split('?')[0]}#${key}`;

/** Who wants to know how far a download has got (0 to 1), by cache key: also a download already under way. */
const progressListeners = new Map<string, Set<(fraction: number) => void>>();
const reportProgress = (id: string, fraction: number) => progressListeners.get(id)?.forEach((listen) => listen(fraction));

/** Read a response to the end, reporting progress when its size is known. */
async function readAll(response: Response, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Download an encrypted file, decrypt it, and return a blob: URL for <img>, <video>, <audio> or a link.
 * `onProgress`: how much has downloaded (0 to 1), also when this file was already downloading.
 */
export function decryptedUrl(url: string, key: string, mime = 'application/octet-stream', v2?: V2File, onProgress?: (fraction: number) => void): Promise<string> {
  const id = cacheKey(url, key);
  if (onProgress) {
    if (!progressListeners.has(id)) progressListeners.set(id, new Set());
    progressListeners.get(id)!.add(onProgress);
  }
  const forget = () => { if (onProgress) progressListeners.get(id)?.delete(onProgress); };
  const cached = objectUrls.get(id);
  if (cached) {
    cached.then(forget, forget);
    return cached;
  }
  const promise = (async () => {
    const response = await fetch(resolveMediaUrl(url)!);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const bytes = await readAll(response, (fraction) => reportProgress(id, fraction));
    const plain = v2 ? decryptMedia(bytes, { key, sha256: v2.sha256, size: v2.size }) : decryptFile(fromBase64(key), bytes);
    return URL.createObjectURL(new Blob([plain], { type: mime }));
  })();
  promise.then((u) => readyUrls.set(id, u), () => objectUrls.delete(id));
  promise.then(forget, forget);
  objectUrls.set(id, promise);
  if (objectUrls.size > MAX_OBJECT_URLS) {
    const [oldest, value] = objectUrls.entries().next().value as [string, Promise<string>];
    objectUrls.delete(oldest);
    readyUrls.delete(oldest);
    value.then((u) => setTimeout(() => URL.revokeObjectURL(u), 60_000)).catch(() => undefined);
  }
  return promise;
}

/** We just encrypted and uploaded this file ourselves: show it from memory instead of downloading it. */
export function rememberDecrypted(url: string, key: string, file: Blob): void {
  const objectUrl = URL.createObjectURL(file);
  objectUrls.set(cacheKey(url, key), Promise.resolve(objectUrl));
  readyUrls.set(cacheKey(url, key), objectUrl);
}

/**
 * The URL to show a media file: the server URL for plain media, or a decrypted blob: URL for
 * encrypted media (undefined while it downloads). `failed` is true if it couldn't be decrypted.
 */
export function useMediaSrc(url?: string, key?: string, mime?: string, v2?: V2File): { src?: string; failed: boolean } {
  const [state, setState] = useState<{ src?: string; failed: boolean; for?: string }>({ failed: false });
  const id = url && key ? cacheKey(url, key) : undefined;

  useEffect(() => {
    if (!url || !key) return;
    let alive = true;
    decryptedUrl(url, key, mime, v2)
      .then((src) => alive && setState({ src, failed: false, for: id }))
      .catch(() => alive && setState({ failed: true, for: id }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, mime, id, v2?.sha256]);

  if (!url) return { failed: false };
  if (!key) return { src: url, failed: false };
  if (state.for === id) return { src: state.src, failed: state.failed };
  const ready = id ? readyUrls.get(id) : undefined; // decrypted earlier: show it straight away
  return ready ? { src: ready, failed: false } : { failed: false };
}

/** Save a decrypted copy under its original name. */
/**
 * Save a decrypted copy under its original name, with a toast that shows it downloading (with the
 * percentage) and says when it's done or why it failed. The file must download and decrypt in the
 * page before the browser can save it, so without this nothing showed for a big file.
 */
export async function downloadDecrypted(url: string, key: string, mime: string | undefined, filename: string, v2?: V2File): Promise<void> {
  const name = withExtension(filename, mime);
  await withDownloadToast(name, async (onProgress) => {
    const src = await decryptedUrl(url, key, mime, v2, onProgress);
    const link = document.createElement('a');
    link.href = src;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
}
