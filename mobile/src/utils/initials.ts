// src/utils/initials.ts
// Initials for avatars from any name, including emoji and Indian scripts. Same file in web and mobile.
//
// name[0] takes half of an emoji (a lone UTF-16 surrogate), which shows as "?" or a box. Here a
// "character" is what a person sees as one: a code point plus what attaches to it (vowel signs and
// other combining marks, skin tones, the emoji variation selector, keycaps, tag sequences), emoji
// joined with zero-width joiners (👨‍👩‍👧), and flags (two regional indicator letters).

const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const ATTACHED = /^[︎️⃣\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const MARK = (() => {
  try {
    return new RegExp('^\\p{M}$', 'u'); // combining marks (Telugu, Hindi vowel signs...)
  } catch {
    return /^[̀-ͯऀ-ॿఀ-౿]$/u; // engines without property escapes
  }
})();
const ZWJ = '‍';

/** The first character of `text` as a person reads it. */
export function firstCharacter(text: string): string {
  const points = Array.from(text);
  if (!points.length) return '';
  let out = points[0];
  if (REGIONAL.test(out) && points[1] && REGIONAL.test(points[1])) return out + points[1];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p === ZWJ && points[i + 1]) {
      out += p + points[i + 1];
      i += 1;
    } else if (ATTACHED.test(p) || MARK.test(p)) {
      out += p;
    } else {
      break;
    }
  }
  return out;
}

/** Up to two initials ("Sai Nath" -> "SN", "🏠 Flat" -> "🏠F"), "?" for nothing. */
export function initials(name?: string | null): string {
  const words = (name || '').trim().split(/[\s_.-]+/).filter(Boolean).slice(0, 2);
  return words.map((w) => firstCharacter(w)).join('').toUpperCase() || '?';
}
