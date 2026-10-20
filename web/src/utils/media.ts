// src/utils/media.ts
import type React from 'react';
import { API_BASE_URL } from '../config/env';
import type { MediaType } from '../services/websocket.service';

// Keep in sync with backend MAX_UPLOAD_SIZE / MAX_VIDEO_UPLOAD_SIZE / MAX_FILE_UPLOAD_SIZE
const MB = 1024 * 1024;
export const MAX_SIZE: Record<MediaType, number> = {
  image: 10 * MB,
  video: 50 * MB,
  audio: 10 * MB,
  file: 150 * MB,
};

export const ACCEPTED_FILE_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

const LISTED = ACCEPTED_FILE_TYPES.split(',');

/** Photos, videos and audio of the listed types are shown in the chat; anything else is a file. */
export const mediaTypeOf = (file: File): MediaType => {
  if (!LISTED.includes(file.type)) return 'file';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
};

/**
 * Returns an error message if the file can't be sent, otherwise null.
 * `anyFile`: sent as a document, so any type goes (an APK, a zip…) as a plain file.
 */
export const validateFile = (file: File, anyFile = false): string | null => {
  if (!anyFile && !LISTED.includes(file.type)) {
    return 'This file type is not supported.';
  }
  const type = mediaTypeOf(file);
  if (file.size > MAX_SIZE[type]) {
    return `File is too large (max ${MAX_SIZE[type] / MB}MB for ${type}s).`;
  }
  return null;
};

/** Media URLs from the server are relative (/api/v1/media/...). */
export const resolveMediaUrl = (url?: string | null): string | undefined => {
  if (!url) return undefined;
  if (url.startsWith('/')) return `${API_BASE_URL}${url}`;
  return url;
};

export const formatFileSize = (bytes?: number | null): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
};

export const messagePreview = (
  text: string | undefined,
  mediaType?: MediaType | null,
  filename?: string | null
): string => {
  if (text) return text;
  if (mediaType === 'image') return 'Photo';
  if (mediaType === 'video') return 'Video';
  if (mediaType === 'audio') return 'Voice message';
  if (mediaType === 'file') return filename || 'File';
  return '';
};

export interface MediaDimensions {
  width: number;
  height: number;
}

/** Pixel size of an image or video file, or null if it can't be read in time. */
export function measureMedia(file: File, timeoutMs = 5000): Promise<MediaDimensions | null> {
  const type = mediaTypeOf(file);
  if (type === 'file') return Promise.resolve(null);

  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const done = (dims: MediaDimensions | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(dims && dims.width > 0 && dims.height > 0 ? dims : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    if (type === 'image') {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done(null);
      img.src = url;
    } else {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => done({ width: video.videoWidth, height: video.videoHeight });
      video.onerror = () => done(null);
      video.src = url;
    }
  });
}

/**
 * A JPEG poster frame from early in a video (shown before it's played),
 * or null if the browser can't decode it. Used for end-to-end encrypted videos, which the
 * server can't make a preview for.
 */
export function captureVideoPoster(file: File, maxSide = 640, timeoutMs = 8000): Promise<File | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (poster: File | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(poster);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => {
      // Skip a possibly black first frame
      video.currentTime = Math.min(0.5, (video.duration || 1) / 4);
    };
    video.onseeked = () => {
      const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) return done(null);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        blob => done(blob ? new File([blob], 'poster.jpg', { type: 'image/jpeg' }) : null),
        'image/jpeg',
        0.8
      );
    };
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * CSS size for a photo/video in a chat bubble, taking the picture's own shape (same rules as the
 * phone app): wide pictures are full width, tall ones full height and narrower, so there are no
 * bars beside or below them. Only very thin or very wide pictures are cropped, to the minimums.
 */
export const MEDIA_BOX = { maxWidth: 300, maxHeight: 340, minWidth: 160, minHeight: 120 };
export function mediaBoxStyle(width: number | undefined, height: number | undefined): React.CSSProperties | undefined {
  if (!width || !height) return undefined;
  const { maxWidth, maxHeight, minWidth, minHeight } = MEDIA_BOX;
  const ratio = width / height;
  return ratio >= maxWidth / maxHeight
    ? { width: maxWidth, height: Math.max(minHeight, Math.round(maxWidth / ratio)) }
    : { width: Math.max(minWidth, Math.round(maxHeight * ratio)), height: maxHeight };
}

/** Upload quality: standard = shrink photos/videos, hd = keep high resolution, original = send as a document. */
export type UploadQuality = 'standard' | 'hd' | 'original';

const replaceExtension = (name: string, type: string) =>
  `${name.replace(/\.[^.]+$/, '') || 'photo'}.${type === 'image/png' ? 'png' : 'jpg'}`;

/**
 * Shrink a photo before upload, like messaging apps do: 1600 px (HD: 4096 px), JPEG.
 * Also drops location/camera metadata (the server strips it again either way).
 * Returns the original file if it can't be decoded, is a GIF, or wouldn't get smaller.
 */
export async function compressImage(file: File, quality: UploadQuality): Promise<File> {
  if (quality === 'original' || file.type === 'image/gif' || typeof createImageBitmap === 'undefined') return file;
  const maxEdge = quality === 'hd' ? 4096 : 1600;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // browsers apply the photo's rotation by default
  } catch {
    return file;
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return file;
  // Small PNGs (screenshots, drawings) stay PNG; everything else becomes JPEG
  const type = file.type === 'image/png' && file.size < 1.5 * MB ? 'image/png' : 'image/jpeg';
  if (type === 'image/jpeg') {
    context.fillStyle = '#ffffff'; // transparent areas become white, not black
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality === 'hd' ? 0.92 : 0.82));
  if (!blob || (scale === 1 && blob.size >= file.size)) return file;
  return new File([blob], replaceExtension(file.name, type), { type, lastModified: Date.now() });
}

/**
 * Save a media file to the device under its own name. The server sends it as an attachment
 * (?download=1&name=...), so the browser downloads it directly: no CORS, no copy in memory.
 */
export async function downloadMedia(url: string, filename: string): Promise<void> {
  const target = new URL(resolveMediaUrl(url)!, window.location.href);
  target.searchParams.set('download', '1');
  target.searchParams.set('name', filename);
  const link = document.createElement('a');
  link.href = target.toString();
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 75 -> "1:15" */
export const formatDuration = (seconds?: number | null): string => {
  if (!seconds || !Number.isFinite(seconds)) return '0:00';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The tiny preview sent inside an encrypted photo's pointer (MediaPointer.blur): a ~24 px JPEG
 * (about 1 KB, base64), shown blurred while the real photo downloads and decrypts.
 * undefined when it can't be made (the photo still sends).
 */
export async function blurPreview(file: Blob): Promise<string | undefined> {
  if (typeof createImageBitmap === 'undefined') return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = 24 / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const b64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
    return b64 && b64.length <= 3000 ? b64 : undefined;
  } catch {
    return undefined;
  }
}

export const blurUri = (b64?: string) => (b64 ? `data:image/jpeg;base64,${b64}` : undefined);
