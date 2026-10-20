// src/utils/avatarTone.ts (same as web/src/utils/avatarTone.ts: keep in sync)
// Soft pastel backgrounds for the person / group icon shown when there's no profile photo, each
// with a deeper shade of the same colour for the icon. Picked from the name, so someone keeps the
// same colour everywhere.

export interface AvatarTone {
  bg: string;
  fg: string;
}

export const AVATAR_TONES: AvatarTone[] = [
  { bg: '#ece8f5', fg: '#6b5a94' }, // lavender
  { bg: '#f5e6e9', fg: '#97586a' }, // rose
  { bg: '#f6ecdf', fg: '#94693d' }, // peach
  { bg: '#e3ecf5', fg: '#4f6d8c' }, // sky
  { bg: '#e3efe7', fg: '#4c7559' }, // sage
  { bg: '#e9ecf0', fg: '#5a6576' }, // slate
  { bg: '#f1ede2', fg: '#7f7150' }, // sand
];

export function avatarTone(name?: string | null): AvatarTone {
  let hash = 0;
  for (const ch of (name || '').trim().toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) || 0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}
