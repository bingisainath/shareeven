// src/utils/personColor.ts
// A light colour per person, so "who owns what" reads at a glance (expense details).
// Same list as web/src/utils/personColor.ts.

const TINTS = [
  { bg: '#efeafd', fg: '#5b45c4' }, // violet
  { bg: '#e3f0fd', fg: '#2563c9' }, // blue
  { bg: '#e1f5ec', fg: '#1a8a5c' }, // green
  { bg: '#fdf1d9', fg: '#a86a00' }, // amber
  { bg: '#fde7f0', fg: '#c2407a' }, // pink
  { bg: '#ddf3f5', fg: '#13808d' }, // teal
  { bg: '#fdeadf', fg: '#c2561c' }, // orange
  { bg: '#eceff3', fg: '#4b5768' }, // slate
];

export type PersonTint = { bg: string; fg: string };

/** Big groups: past the list, step round the colour wheel by the golden angle so hues stay apart. */
const generated = (n: number): PersonTint => {
  const hue = Math.round((n * 137.508) % 360);
  return { bg: `hsl(${hue}, 70%, 94%)`, fg: `hsl(${hue}, 55%, 36%)` };
};

/**
 * Colour for `userId`. Pass the chat's member ids so people get distinct colours in member order
 * (the same on every expense in that chat); anyone not in the list falls back to a hash of their id.
 */
export function personTint(userId: string, memberIds: string[] = []): PersonTint {
  const n = memberIds.indexOf(userId);
  if (n >= 0) return n < TINTS.length ? TINTS[n] : generated(n);
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) % 1000000007;
  return TINTS[hash % TINTS.length];
}
