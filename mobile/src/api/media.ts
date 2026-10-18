// src/api/media.ts
// Upload a photo, video, voice note or document to the ShareEven server (same endpoint as the web app).
import { api } from './client';

export type UploadQuality = 'standard' | 'hd' | 'original';

export interface LocalFile {
  uri: string;
  type: string; // mime type
  name: string;
}

export interface Uploaded {
  url: string;
  signedUrl: string;
  mediaType: 'image' | 'video' | 'audio' | 'file';
  mimeType: string;
  size: number;
  filename: string;
  width?: number | null;
  height?: number | null;
  /** Videos: poster frame made by the server, and the length in seconds */
  thumbnailUrl?: string | null;
  thumbnailSignedUrl?: string | null;
  duration?: number | null;
}

// Keep in sync with backend media_storage.ALLOWED_TYPES / MAX_*_SIZE
const MB = 1024 * 1024;
export const ALLOWED: Record<string, 'image' | 'video' | 'audio' | 'file'> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'audio/webm': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio', 'audio/mpeg': 'audio',
  'application/pdf': 'file', 'application/msword': 'file',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file',
};
export const maxSize = (kind: string) => (kind === 'video' ? 50 * MB : kind === 'file' ? 150 * MB : 10 * MB);

/** What an upload counts as. As a document, any type goes (an APK, a zip…): it's sent as a plain file. */
export const kindOf = (type: string, anyFile = false): 'image' | 'video' | 'audio' | 'file' | undefined =>
  ALLOWED[type] || (anyFile ? 'file' : undefined);

/** Why this file can't be sent, or null. */
export function fileProblem(type: string, size?: number | null, anyFile = false): string | null {
  const kind = kindOf(type, anyFile);
  if (!kind) return 'This file type is not supported';
  if (size && size > maxSize(kind)) return `Too large (max ${maxSize(kind) / MB} MB)`;
  return null;
}

export async function uploadFile(
  file: LocalFile,
  options: {
    quality?: UploadQuality;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
    encrypted?: 'image' | 'video' | 'audio' | 'file' | 'backup'; // end-to-end encrypted by the app (crypto/media.ts)
  } = {},
): Promise<Uploaded> {
  const form = new FormData();
  form.append('file', { uri: file.uri, type: file.type, name: file.name } as any);
  const response = await api.post('/media/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    params: options.encrypted
      ? { encrypted: true, kind: options.encrypted }
      : options.quality ? { quality: options.quality } : undefined,
    signal: options.signal,
    timeout: 10 * 60 * 1000, // big videos on slow connections (the server also compresses them)
    onUploadProgress: (e) => {
      if (options.onProgress && e.total) options.onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return response.data.data;
}
