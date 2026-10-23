// src/components/chat/ZoomableImage.tsx
// A photo in the full-screen viewer: pinch or double-tap to zoom, drag to look around while
// zoomed, tap to show or hide the viewer's buttons, and (not zoomed) swipe sideways to the next
// photo, which it hands to the viewer (onSwipe). Uses React Native's own touch handling
// (PanResponder), no native gesture library. It owns every touch on the photo: a native scrolling
// pager took two-finger pinches for sideways swipes. The math is in utils/zoom.ts.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, GestureResponderEvent, Image, PanResponder, View } from 'react-native';
import { clampOffset, clampScale, fitSize, MAX_ZOOM, NO_ZOOM, settle, Size, toggleZoom, zoomAt, ZoomState } from '../../utils/zoom';

interface Props {
  uri: string;
  width: number; // the page it fills (the screen)
  height: number;
  /** The photo on screen: another photo's zoom is reset when it scrolls away. */
  active: boolean;
  onZoomChange?: (zoomed: boolean) => void;
  onTap?: () => void;
  /** Not zoomed, one finger moving sideways: how far, to move the viewer's pages along. */
  onSwipe?: (dx: number) => void;
  /** The swipe ended: how far, and how fast (px/ms; negative is leftwards). */
  onSwipeEnd?: (dx: number, vx: number) => void;
}

const DOUBLE_TAP_MS = 280;
const TAP_SLOP = 10;

type Touch = { pageX: number; pageY: number };
const distance = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
const middle = (a: Touch, b: Touch) => ({ x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 });

const ZoomableImage: React.FC<Props> = ({ uri, width, height, active, onZoomChange, onTap, onSwipe, onSwipeEnd }) => {
  const [picture, setPicture] = useState<Size | null>(null);
  useEffect(() => {
    let alive = true;
    Image.getSize(uri, (w, h) => alive && setPicture({ width: w, height: h }), () => undefined);
    return () => { alive = false; };
  }, [uri]);

  const box = useMemo(() => ({ width, height }), [width, height]);
  const content = fitSize(picture, box);
  // The gesture handlers are made once: they read the latest sizes and callbacks from here
  const latest = useRef({ box, content, onZoomChange, onTap, onSwipe, onSwipeEnd });
  latest.current = { box, content, onZoomChange, onTap, onSwipe, onSwipeEnd };

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const zoom = useRef<ZoomState>(NO_ZOOM);
  const zoomed = useRef(false);

  const tellZoomed = (now: boolean) => {
    if (zoomed.current !== now) {
      zoomed.current = now;
      latest.current.onZoomChange?.(now);
    }
  };
  const show = (z: ZoomState, animate = false) => {
    zoom.current = z;
    if (animate) {
      Animated.parallel([
        Animated.spring(scale, { toValue: z.scale, useNativeDriver: false, bounciness: 0 }),
        Animated.spring(tx, { toValue: z.x, useNativeDriver: false, bounciness: 0 }),
        Animated.spring(ty, { toValue: z.y, useNativeDriver: false, bounciness: 0 }),
      ]).start();
    } else {
      scale.setValue(z.scale);
      tx.setValue(z.x);
      ty.setValue(z.y);
    }
  };

  // Scrolled to another photo: this one goes back to fitting the screen
  useEffect(() => {
    if (!active && zoom.current !== NO_ZOOM) {
      show(NO_ZOOM);
      tellZoomed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const responder = useMemo(() => {
    // One gesture: where it started, and whether it has become more than a tap
    let start: ZoomState = NO_ZOOM;
    let mode: 'pan' | 'pinch' = 'pan';
    let from = { x: 0, y: 0 }; // the finger (pan) or the point between the fingers (pinch)
    let startDistance = 1;
    let moved = false;
    let startedAt = 0;
    let lastTap = { at: 0, x: 0, y: 0 };
    let tapTimer: ReturnType<typeof setTimeout> | undefined;
    // A sideways swipe to the next or previous photo (only when not zoomed)
    let swiping = false;
    let swipeDx = 0;
    let samples: { x: number; t: number }[] = [];
    const endSwipe = (dx: number, vx: number) => {
      if (!swiping) return;
      swiping = false;
      latest.current.onSwipeEnd?.(dx, vx);
    };
    const velocity = () => {
      const [a, b] = [samples[0], samples[samples.length - 1]];
      return a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
    };

    // Measured from the centre of the screen, where the photo is centred
    const fromCentre = (p: { x: number; y: number }) => ({ x: p.x - latest.current.box.width / 2, y: p.y - latest.current.box.height / 2 });

    const begin = (touches: Touch[]) => {
      start = zoom.current;
      if (touches.length >= 2) {
        mode = 'pinch';
        from = middle(touches[0], touches[1]);
        startDistance = Math.max(1, distance(touches[0], touches[1]));
        endSwipe(0, 0); // a second finger during a swipe: back to this photo, and pinch
        tellZoomed(true);
      } else {
        mode = 'pan';
        from = { x: touches[0].pageX, y: touches[0].pageY };
      }
    };

    const finish = () => {
      const { content: c, box: b } = latest.current;
      const rest = settle(zoom.current, c, b);
      show(rest, true);
      tellZoomed(rest.scale > 1);
    };

    const tapped = (x: number, y: number) => {
      const now = Date.now();
      if (now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
        if (tapTimer) clearTimeout(tapTimer);
        lastTap = { at: 0, x: 0, y: 0 };
        const { content: c, box: b } = latest.current;
        const next = toggleZoom(zoom.current, fromCentre({ x, y }), c, b);
        show(next, true);
        tellZoomed(next.scale > 1);
        return;
      }
      lastTap = { at: now, x, y };
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => latest.current.onTap?.(), DOUBLE_TAP_MS);
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Every touch on the photo is ours, so nothing native can take a pinch for a scroll
      onShouldBlockNativeResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        moved = false;
        swiping = false;
        samples = [];
        startedAt = Date.now();
        begin(e.nativeEvent.touches);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const touches = e.nativeEvent.touches;
        if (!touches.length) return;
        const { content: c, box: b } = latest.current;
        if (touches.length >= 2) {
          if (mode !== 'pinch') begin(touches); // a second finger came down
          moved = true;
          const mid = middle(touches[0], touches[1]);
          // A little past the limits while pinching; settles back when the fingers lift
          const s = clampScale((start.scale * distance(touches[0], touches[1])) / startDistance, 0.6, MAX_ZOOM * 1.4);
          const z = zoomAt(start, fromCentre(from), s);
          show({ scale: s, x: z.x + mid.x - from.x, y: z.y + mid.y - from.y });
          return;
        }
        if (mode === 'pinch') {
          begin(touches); // one finger lifted: carry on as a drag
          return;
        }
        const dx = touches[0].pageX - from.x;
        const dy = touches[0].pageY - from.y;
        if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP) moved = true;
        if (start.scale > 1) {
          show(clampOffset({ scale: start.scale, x: start.x + dx, y: start.y + dy }, c, b));
          return;
        }
        if (!swiping && Math.abs(dx) > TAP_SLOP && Math.abs(dx) > Math.abs(dy)) swiping = true;
        if (swiping) {
          swipeDx = dx;
          samples = [...samples, { x: touches[0].pageX, t: e.nativeEvent.timestamp || Date.now() }].slice(-4);
          latest.current.onSwipe?.(dx);
        }
      },
      onPanResponderRelease: (e: GestureResponderEvent) => {
        if (!moved && Date.now() - startedAt < 300) tapped(e.nativeEvent.pageX, e.nativeEvent.pageY);
        endSwipe(swipeDx, velocity());
        finish();
      },
      onPanResponderTerminate: () => {
        endSwipe(0, 0);
        finish();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }} {...responder.panHandlers}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={{ width, height, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}
      />
    </View>
  );
};

export default ZoomableImage;
