import React from 'react';
import { Animated, Image } from 'react-native';
import renderer, { act, ReactTestRenderer } from 'react-test-renderer';
import ZoomableImage from './ZoomableImage';

// A 1600 x 1200 photo on a 400 x 800 screen: drawn 400 x 300, centred at (200, 400)
const W = 400;
const H = 800;

type Pt = [number, number];
let clock = 1;
// Each event has its own time: PanResponder skips a move with the same timestamp as the last one
const touchEvent = (points: Pt[], at = (clock += 16)) => {
  const touches = points.map(([pageX, pageY], identifier) => ({ pageX, pageY, locationX: pageX, locationY: pageY, identifier, timestamp: at }));
  return {
    nativeEvent: { touches, changedTouches: touches, pageX: touches[0]?.pageX, pageY: touches[0]?.pageY, timestamp: at },
    // What PanResponder's own bookkeeping reads (ZoomableImage itself only uses nativeEvent.touches)
    touchHistory: {
      numberActiveTouches: touches.length, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: at,
      touchBank: touches.map((t) => ({
        touchActive: true, startPageX: t.pageX, startPageY: t.pageY, startTimeStamp: at,
        currentPageX: t.pageX, currentPageY: t.pageY, currentTimeStamp: at, previousPageX: t.pageX, previousPageY: t.pageY, previousTimeStamp: at,
      })),
    },
  };
};

function setup(props: Partial<React.ComponentProps<typeof ZoomableImage>> = {}) {
  const onZoomChange = jest.fn();
  const onTap = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(<ZoomableImage uri="file:///p.jpg" width={W} height={H} active onZoomChange={onZoomChange} onTap={onTap} {...props} />);
  });
  const view = () => tree.root.findAll((n) => typeof n.props.onResponderGrant === 'function')[0];
  const zoom = () => {
    const [{ translateX }, { translateY }, { scale }] = tree.root.findByType(Animated.Image).props.style.transform;
    return { x: translateX.__getValue(), y: translateY.__getValue(), scale: scale.__getValue() };
  };
  const call = (name: string, e: object) => act(() => { view().props[name](e); });
  const gesture = (frames: Pt[][]) => {
    call('onResponderGrant', touchEvent(frames[0]));
    for (const f of frames.slice(1)) call('onResponderMove', touchEvent(f));
    call('onResponderRelease', touchEvent([frames[frames.length - 1][0]]));
  };
  const tap = (x: number, y: number) => gesture([[[x, y]]]);
  const finish = () => act(() => { jest.advanceTimersByTime(2000); });
  return { tree, view, zoom, call, gesture, tap, finish, onZoomChange, onTap };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, ok) => ok(1600, 1200));
});
afterEach(() => jest.useRealTimers());

const pinchOut = (cx: number, cy: number, from: number, to: number, steps = 6): Pt[][] =>
  Array.from({ length: steps + 1 }, (_, k) => {
    const half = (from + ((to - from) * k) / steps) / 2;
    return [[cx - half, cy], [cx + half, cy]];
  });

describe('ZoomableImage', () => {
  it('pinching zooms in around the fingers, and tells the viewer to stop paging', () => {
    const z = setup();
    z.gesture(pinchOut(150, 400, 60, 240)); // 4x, 50 px left of centre
    z.finish();
    const { scale, x } = z.zoom();
    expect(scale).toBeCloseTo(4, 1);
    expect(x).toBeCloseTo(-50 - (-50) * 4, 0); // the spot between the fingers stayed put: 150
    expect(z.onZoomChange).toHaveBeenCalledWith(true);
    expect(z.onZoomChange).not.toHaveBeenCalledWith(false);
  });

  it('zoomed: one finger drags the photo, but not off screen', () => {
    const z = setup();
    z.gesture(pinchOut(200, 400, 100, 300)); // 3x: 1200 x 900, so 400 px of room each side, 50 up/down
    z.finish();
    z.gesture([[[200, 400]], [[230, 420]], [[260, 440]]]);
    z.finish();
    expect(z.zoom()).toMatchObject({ x: expect.closeTo(60, 0), y: expect.closeTo(40, 0) });
    z.gesture([[[200, 400]], [[-2000, 3000]]]);
    z.finish();
    expect(z.zoom()).toMatchObject({ x: expect.closeTo(-400, 0), y: expect.closeTo(50, 0) });
  });

  it('pinching back in past the start returns to fit and lets the viewer page again', () => {
    const z = setup();
    z.gesture(pinchOut(200, 400, 100, 250));
    z.finish();
    z.gesture(pinchOut(200, 400, 300, 40));
    z.finish();
    expect(z.zoom()).toEqual({ scale: 1, x: 0, y: 0 });
    expect(z.onZoomChange).toHaveBeenLastCalledWith(false);
  });

  it('never stays zoomed past 5x', () => {
    const z = setup();
    z.gesture(pinchOut(200, 400, 20, 380));
    z.finish();
    expect(z.zoom().scale).toBeCloseTo(5, 5);
  });

  it('double-tap zooms in on the spot and back out; a single tap shows or hides the buttons', () => {
    const z = setup();
    z.tap(300, 400);
    act(() => { jest.advanceTimersByTime(100); });
    z.tap(300, 400);
    z.finish();
    expect(z.zoom().scale).toBeCloseTo(2.5, 5);
    expect(z.zoom().x).toBeCloseTo(100 - 100 * 2.5, 0);
    expect(z.onTap).not.toHaveBeenCalled();
    z.tap(300, 400);
    act(() => { jest.advanceTimersByTime(100); });
    z.tap(300, 400);
    z.finish();
    expect(z.zoom()).toEqual({ scale: 1, x: 0, y: 0 });
    z.tap(200, 400);
    z.finish();
    expect(z.onTap).toHaveBeenCalledTimes(1);
  });

  it('keeps every touch, so nothing native can take a pinch for a scroll', () => {
    const z = setup();
    expect(z.view().props.onResponderTerminationRequest(touchEvent([[0, 0]]))).toBe(false);
  });

  it('not zoomed: a sideways drag swipes to the next photo instead of moving this one', () => {
    const onSwipe = jest.fn();
    const onSwipeEnd = jest.fn();
    const z = setup({ onSwipe, onSwipeEnd });
    z.gesture([[[300, 400]], [[280, 402]], [[200, 405]], [[120, 404]]]);
    z.finish();
    expect(onSwipe).toHaveBeenLastCalledWith(-180);
    expect(onSwipeEnd).toHaveBeenCalledWith(-180, expect.any(Number));
    expect(onSwipeEnd.mock.calls[0][1]).toBeLessThan(0); // moving left
    expect(z.zoom()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('zoomed: a sideways drag moves the photo, not to the next one', () => {
    const onSwipe = jest.fn();
    const z = setup({ onSwipe });
    z.gesture(pinchOut(200, 400, 100, 300));
    z.finish();
    z.gesture([[[300, 400]], [[200, 400]]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('a mostly vertical drag or a pinch is not a swipe', () => {
    const onSwipe = jest.fn();
    const onSwipeEnd = jest.fn();
    const z = setup({ onSwipe, onSwipeEnd });
    z.gesture([[[200, 300]], [[205, 360]], [[210, 450]]]);
    z.gesture(pinchOut(200, 400, 60, 240));
    expect(onSwipe).not.toHaveBeenCalled();
    expect(onSwipeEnd).not.toHaveBeenCalled();
  });

  it('a second finger during a swipe goes back to this photo and pinches', () => {
    const onSwipeEnd = jest.fn();
    const z = setup({ onSwipeEnd });
    z.call('onResponderGrant', touchEvent([[300, 400]]));
    z.call('onResponderMove', touchEvent([[250, 400]]));
    z.call('onResponderMove', touchEvent([[250, 400], [310, 400]]));
    expect(onSwipeEnd).toHaveBeenCalledWith(0, 0);
    z.call('onResponderMove', touchEvent([[220, 400], [340, 400]]));
    z.call('onResponderRelease', touchEvent([[220, 400]]));
    z.finish();
    expect(z.zoom().scale).toBeCloseTo(2, 1);
    expect(onSwipeEnd).toHaveBeenCalledTimes(1);
  });

  it('a gesture taken over by the system settles instead of staying half-pinched', () => {
    const z = setup();
    z.call('onResponderGrant', touchEvent([[150, 400], [250, 400]]));
    z.call('onResponderMove', touchEvent([[190, 400], [210, 400]])); // pinched to 0.2x
    z.call('onResponderTerminate', touchEvent([[190, 400]]));
    z.finish();
    expect(z.zoom()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('resets when another photo is shown', () => {
    const z = setup();
    z.gesture(pinchOut(200, 400, 100, 300));
    z.finish();
    act(() => {
      z.tree.update(<ZoomableImage uri="file:///p.jpg" width={W} height={H} active={false} onZoomChange={z.onZoomChange} onTap={z.onTap} />);
    });
    expect(z.zoom()).toEqual({ scale: 1, x: 0, y: 0 });
    expect(z.onZoomChange).toHaveBeenLastCalledWith(false);
  });
});
