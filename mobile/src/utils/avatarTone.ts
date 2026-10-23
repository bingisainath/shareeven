// src/utils/avatarTone.ts (same as web/src/utils/avatarTone.ts: keep in sync)
// The picture shown when there's no profile photo, like WhatsApp's: a solid person (or two, for a
// group) whose shoulders run off the bottom of the circle, in a deeper shade of a soft colour.
// The colour is picked from the name, so someone keeps the same colour everywhere.

export interface AvatarTone {
  bg: string;
  fg: string;
}

export const AVATAR_TONES: AvatarTone[] = [
  { bg: '#ddd6ec', fg: '#9384b8' }, // lavender
  { bg: '#ecd7dc', fg: '#b47f8e' }, // rose
  { bg: '#ecdfcd', fg: '#b48f68' }, // peach
  { bg: '#d4e0ec', fg: '#7c97b3' }, // sky
  { bg: '#d4e4d9', fg: '#7a9d85' }, // sage
  { bg: '#dbe0e6', fg: '#8a94a3' }, // slate
  { bg: '#e6e0cf', fg: '#a8996f' }, // sand
];

export function avatarTone(name?: string | null): AvatarTone {
  let hash = 0;
  for (const ch of (name || '').trim().toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) || 0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

/** The silhouettes, drawn in a 24 x 24 box that fills the circle (the circle cuts off the shoulders). */
export const PERSON_SHAPES: { d: string; opacity?: number }[] = [
  { d: 'M12 4.6a4.6 4.6 0 1 1 0 9.2a4.6 4.6 0 1 1 0-9.2Z' },
  { d: 'M2.6 25C2.6 19.1 6.8 15.6 12 15.6S21.4 19.1 21.4 25Z' },
];
export const GROUP_SHAPES: { d: string; opacity?: number }[] = [
  { d: 'M15.6 5.2a3.4 3.4 0 1 1 0 6.8a3.4 3.4 0 1 1 0-6.8Z', opacity: 0.7 },
  { d: 'M10.6 25C10.6 17.7 13 13.6 15.9 13.6C19.2 13.6 22.6 17 22.6 25Z', opacity: 0.7 },
  { d: 'M9 7.4a3.9 3.9 0 1 1 0 7.8a3.9 3.9 0 1 1 0-7.8Z' },
  { d: 'M1.4 25C1.4 19.8 4.8 16.6 9 16.6S16.6 19.8 16.6 25Z' },
];
