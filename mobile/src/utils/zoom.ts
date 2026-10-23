// src/utils/zoom.ts
// The arithmetic of zooming a photo in the full-screen viewer (pinch, double-tap, drag), kept
// apart from the gestures so it can be tested. Same file in web/src/utils/zoom.ts.
//
// A photo is drawn centred in its box, then moved by (x, y) and scaled by `scale` around its
// centre (CSS/React Native transform: translate, then scale). Points are measured from the
// box's centre.

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MAX_ZOOM = 5;
export const DOUBLE_TAP_ZOOM = 2.5;
export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 };

export const clampScale = (scale: number, min = 1, max = MAX_ZOOM) => Math.min(max, Math.max(min, scale));

/** The size a picture is drawn at when it's fitted inside a box ("contain"). */
export function fitSize(picture: Size | null | undefined, box: Size): Size {
  if (!picture || picture.width <= 0 || picture.height <= 0) return box;
  const k = Math.min(box.width / picture.width, box.height / picture.height);
  return { width: picture.width * k, height: picture.height * k };
}

/** Keep a zoomed picture covering the box: no dragging it off screen, and centred on an axis where it's smaller than the box. */
export function clampOffset(z: ZoomState, content: Size, box: Size): ZoomState {
  const limit = (size: number, room: number) => Math.max(0, (size * z.scale - room) / 2);
  const lx = limit(content.width, box.width);
  const ly = limit(content.height, box.height);
  const clamp = (v: number, l: number) => Math.min(l, Math.max(-l, v)) || 0; // no -0
  return { scale: z.scale, x: clamp(z.x, lx), y: clamp(z.y, ly) };
}

/** Zoom to `scale` keeping the spot under `point` (from the box's centre) where it is. */
export function zoomAt(z: ZoomState, point: { x: number; y: number }, scale: number): ZoomState {
  const k = scale / z.scale;
  return { scale, x: point.x - (point.x - z.x) * k, y: point.y - (point.y - z.y) * k };
}

/** Where a gesture should come to rest: back to no zoom when barely zoomed, else inside the limits. */
export function settle(z: ZoomState, content: Size, box: Size): ZoomState {
  const scale = clampScale(z.scale);
  if (scale <= 1.01) return NO_ZOOM;
  // Zoomed past the maximum: shrink back around the centre of the box
  const back = scale === z.scale ? z : zoomAt(z, { x: 0, y: 0 }, scale);
  return clampOffset(back, content, box);
}

/** Double-tap: zoom in on the tapped spot, or out again when already zoomed. */
export function toggleZoom(z: ZoomState, point: { x: number; y: number }, content: Size, box: Size): ZoomState {
  if (z.scale > 1.01) return NO_ZOOM;
  return clampOffset(zoomAt(z, point, DOUBLE_TAP_ZOOM), content, box);
}
