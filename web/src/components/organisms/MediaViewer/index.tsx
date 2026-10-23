// src/components/organisms/MediaViewer/index.tsx
// Full-screen viewer for photos and videos (a conversation's, or a receipt): swipe or arrow keys to
// move between them. Photos zoom with the mouse wheel, a trackpad or two-finger pinch, double-click
// or the zoom buttons (+ and - keys); drag to look around while zoomed. The math is in utils/zoom.ts.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Forward, ZoomIn, ZoomOut } from 'lucide-react';
import { toast } from 'react-toastify';
import Icon from '../../atoms/Icon';
import { downloadMedia } from '../../../utils/media';
import { downloadDecrypted, useMediaSrc } from '../../../crypto/media';
import { Lock } from 'lucide-react';
import { formatMessageTime } from '../../../utils/dateFormat';
import { clampOffset, clampScale, MAX_ZOOM, NO_ZOOM, settle, toggleZoom, zoomAt, ZoomState } from '../../../utils/zoom';

export interface ViewerImage {
  id: string;
  url: string;
  filename?: string;
  senderName?: string;
  timestamp?: string;
  type?: 'image' | 'video';
  mediaKey?: string; // end-to-end encrypted: decrypted in the browser
  mediaMime?: string;
  mediaV2?: { sha256: string; size: number };
}

interface MediaViewerProps {
  images: ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onForward?: (id: string) => void;
}

const STEP = 1.6; // one press of a zoom button or key

type Point = { x: number; y: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const MediaViewer: React.FC<MediaViewerProps> = ({ images, index, onIndexChange, onClose, onForward }) => {
  const image = images[index];
  const media = useMediaSrc(image?.url, image?.mediaKey, image?.mediaMime, image?.mediaV2);
  const isPhoto = !!image && image.type !== 'video' && !!media.src;
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  const [zoom, setZoomState] = useState<ZoomState>(NO_ZOOM);
  const [gesturing, setGesturing] = useState(false); // no easing while fingers or the mouse move it
  // Events can come faster than renders (a fast wheel or pinch): each one builds on the latest zoom, not the last render's
  const zoomRef = useRef(zoom);
  const setZoom = useCallback((z: ZoomState) => {
    zoomRef.current = z;
    setZoomState(z);
  }, []);
  const zoomed = zoom.scale > 1;
  const stage = useRef<HTMLDivElement>(null);
  const photo = useRef<HTMLImageElement>(null);

  useEffect(() => setZoom(NO_ZOOM), [image?.id, setZoom]);

  /** The stage and the photo's fitted (unzoomed) size, and where a screen point is from the photo's centre. */
  const measure = useCallback(() => {
    const s = stage.current;
    const p = photo.current;
    if (!s || !p) return null;
    // The fitted photo's centre: layout offsets ignore the zoom (and any zoom still easing in)
    const r = s.getBoundingClientRect();
    const cx = r.left + p.offsetLeft + p.offsetWidth / 2;
    const cy = r.top + p.offsetTop + p.offsetHeight / 2;
    return {
      box: { width: s.clientWidth, height: s.clientHeight },
      content: { width: p.offsetWidth, height: p.offsetHeight }, // layout size: transforms don't count
      at: (clientX: number, clientY: number) => ({ x: clientX - cx, y: clientY - cy }),
    };
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const m = measure();
    if (!m) return;
    const z = zoomRef.current;
    setZoom(settle(zoomAt(z, { x: 0, y: 0 }, clampScale(z.scale * factor)), m.content, m.box));
  }, [measure, setZoom]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev && zoomRef.current.scale <= 1) onIndexChange(index - 1);
      else if (e.key === 'ArrowRight' && hasNext && zoomRef.current.scale <= 1) onIndexChange(index + 1);
      else if (isPhoto && (e.key === '+' || e.key === '=')) zoomBy(STEP);
      else if (isPhoto && e.key === '-') zoomBy(1 / STEP);
      else if (isPhoto && e.key === '0') setZoom(NO_ZOOM);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [index, hasPrev, hasNext, isPhoto, onClose, onIndexChange, zoomBy, setZoom]);

  // Wheel and trackpad pinch zoom towards the pointer. Not a React handler: it must be able to stop the page scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el || !isPhoto) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = measure();
      if (!m) return;
      const z = zoomRef.current;
      const scale = clampScale(z.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      setZoom(settle(zoomAt(z, m.at(e.clientX, e.clientY), scale), m.content, m.box));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isPhoto, measure, setZoom]);

  // Pointers (mouse, finger, pen) on the stage: one drags (or swipes to the next photo when not zoomed), two pinch
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: ZoomState; from: Point; startDistance: number; pinched: boolean; moved: boolean; swipeFrom: number | null } | null>(null);
  const skipClick = useRef(false);

  const begin = () => {
    const list = Array.from(pointers.current.values());
    const prev = gesture.current;
    gesture.current = {
      start: zoomRef.current,
      from: list.length >= 2 ? middle(list[0], list[1]) : list[0],
      startDistance: list.length >= 2 ? Math.max(1, distance(list[0], list[1])) : 1,
      pinched: (prev?.pinched ?? false) || list.length >= 2,
      moved: prev?.moved ?? false,
      swipeFrom: prev ? prev.swipeFrom : list[0].x,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'VIDEO' || (e.target as HTMLElement).closest('button')) return; // video controls need drags
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointers.current.size === 0) gesture.current = null;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
    if (isPhoto) setGesturing(true);
  };

  type PointerInfo = { pointerId: number; clientX: number; clientY: number };

  const onPointerMove = (e: PointerInfo) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const list = Array.from(pointers.current.values());
    if (!isPhoto) return;
    const m = measure();
    if (!m) return;
    if (list.length >= 2) {
      g.moved = true;
      const mid = middle(list[0], list[1]);
      const scale = clampScale((g.start.scale * distance(list[0], list[1])) / g.startDistance, 0.6, MAX_ZOOM * 1.4);
      // Scale around where the fingers started, then follow them as they move together
      const z = zoomAt(g.start, m.at(g.from.x, g.from.y), scale);
      setZoom({ scale, x: z.x + mid.x - g.from.x, y: z.y + mid.y - g.from.y });
      return;
    }
    const dx = list[0].x - g.from.x;
    const dy = list[0].y - g.from.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) g.moved = true;
    if (g.start.scale > 1) setZoom(clampOffset({ scale: g.start.scale, x: g.start.x + dx, y: g.start.y + dy }, m.content, m.box));
  };

  const onPointerUp = (e: PointerInfo) => {
    if (!pointers.current.delete(e.pointerId) || !gesture.current) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      begin(); // one finger of a pinch lifted: carry on as a drag from here
      return;
    }
    gesture.current = null;
    setGesturing(false);
    skipClick.current = g.moved;
    // Not zoomed and not pinched: a sideways swipe moves to the next or previous one
    if (!g.pinched && g.start.scale <= 1 && g.swipeFrom !== null) {
      const dx = e.clientX - g.swipeFrom;
      if (dx > 50 && hasPrev) onIndexChange(index - 1);
      else if (dx < -50 && hasNext) onIndexChange(index + 1);
    }
    const m = measure();
    if (m) setZoom(settle(zoomRef.current, m.content, m.box));
  };

  const onPointerCancel = (e: PointerInfo) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setGesturing(false);
      const m = measure();
      if (m) setZoom(settle(zoomRef.current, m.content, m.box));
    }
  };

  // Moves and releases are followed on the whole window, so a drag that ends over the top bar or
  // outside the browser still ends (the stage alone would keep a pointer it never saw lifted)
  const handlers = useRef({ onPointerMove, onPointerUp, onPointerCancel });
  handlers.current = { onPointerMove, onPointerUp, onPointerCancel };
  useEffect(() => {
    const move = (e: PointerEvent) => handlers.current.onPointerMove(e);
    const up = (e: PointerEvent) => handlers.current.onPointerUp(e);
    const cancel = (e: PointerEvent) => handlers.current.onPointerCancel(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  if (!image) return null;

  const download = () => {
    const name = image.filename || (image.type === 'video' ? 'ShareEven video' : 'ShareEven photo'); // the extension is added from the type
    if (image.mediaKey) downloadDecrypted(image.url, image.mediaKey, image.mediaMime, name, image.mediaV2); // shows its own progress
    else downloadMedia(image.url, name).catch(() => toast.error("Couldn't download it. Try again"));
  };

  return (
    <div
      role="dialog"
      aria-label="Media viewer"
      className="fixed inset-0 z-[60] flex flex-col bg-black/90 animate-fade-in select-none"
    >
      {/* Top bar */}
      <div className="flex items-center gap-1 px-4 py-3 text-white">
        <div className="flex-1 min-w-0 mr-2">
          <p className="text-sm font-semibold truncate">{image.senderName || 'Photo'}</p>
          <p className="text-xs text-white/60">
            {[image.timestamp && formatMessageTime(image.timestamp), images.length > 1 && `${index + 1} of ${images.length}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        {isPhoto && (
          <>
            <button onClick={() => zoomBy(1 / STEP)} disabled={!zoomed} className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent" title="Zoom out (-)" aria-label="Zoom out">
              <ZoomOut className="w-5 h-5" />
            </button>
            <button onClick={() => zoomBy(STEP)} disabled={zoom.scale >= MAX_ZOOM} className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent" title="Zoom in (+)" aria-label="Zoom in">
              <ZoomIn className="w-5 h-5" />
            </button>
          </>
        )}
        {onForward && (
          <button onClick={() => onForward(image.id)} className="p-2 rounded-lg hover:bg-white/10" title="Forward" aria-label="Forward">
            <Forward className="w-5 h-5" />
          </button>
        )}
        <button onClick={download} className="p-2 rounded-lg hover:bg-white/10" title="Download" aria-label="Download">
          <Download className="w-5 h-5" />
        </button>
        <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" title="Close" aria-label="Close">
          <Icon name="close" size={22} className="text-white" />
        </button>
      </div>

      {/* Photo or video (click the backdrop to close, swipe to move, pinch/wheel/double-click to zoom) */}
      <div
        ref={stage}
        className={`relative flex-1 min-h-0 flex items-center justify-center overflow-hidden px-4 pb-6 ${isPhoto ? 'touch-none' : ''}`}
        onClick={(e) => {
          const dragged = skipClick.current;
          skipClick.current = false;
          if (e.target === e.currentTarget && !dragged && !zoomed) onClose();
        }}
        onPointerDown={onPointerDown}
      >
        {!media.src ? (
          <p className="flex items-center gap-2 text-sm text-white/70">
            <Lock className="w-4 h-4 animate-pulse" /> {media.failed ? "Couldn't decrypt this photo" : 'Decrypting…'}
          </p>
        ) : image.type === 'video' ? (
          <video key={image.id} src={media.src} controls autoPlay playsInline className="max-w-full max-h-full rounded-lg bg-black" />
        ) : (
          <img
            ref={photo}
            key={image.id}
            src={media.src}
            alt={image.filename || 'Photo'}
            draggable={false}
            onDoubleClick={(e) => {
              const m = measure();
              if (m) setZoom(toggleZoom(zoomRef.current, m.at(e.clientX, e.clientY), m.content, m.box));
            }}
            style={{
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
              transition: gesturing ? 'none' : 'transform 160ms ease-out',
              cursor: zoomed ? (gesturing ? 'grabbing' : 'grab') : 'zoom-in',
            }}
            className={`max-w-full max-h-full object-contain shadow-elevated animate-fade-in will-change-transform ${zoomed ? '' : 'rounded-lg'}`}
          />
        )}

        {hasPrev && !zoomed && (
          <button
            onClick={() => onIndexChange(index - 1)}
            className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white"
            title="Previous"
            aria-label="Previous image"
          >
            <Icon name="back" size={22} />
          </button>
        )}
        {hasNext && !zoomed && (
          <button
            onClick={() => onIndexChange(index + 1)}
            className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white"
            title="Next"
            aria-label="Next image"
          >
            <Icon name="forward" size={22} />
          </button>
        )}
      </div>
    </div>
  );
};

export default MediaViewer;
