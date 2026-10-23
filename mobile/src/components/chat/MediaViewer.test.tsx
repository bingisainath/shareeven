import React from 'react';
import { Image, Text } from 'react-native';
import renderer, { act, ReactTestRenderer } from 'react-test-renderer';
import MediaViewer, { swipeTarget, ViewerItem } from './MediaViewer';
import ZoomableImage from './ZoomableImage';

jest.mock('react-native-video', () => 'Video');
jest.mock('lucide-react-native', () => ({ Download: 'Download', Forward: 'Forward', X: 'X', Lock: 'Lock' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));

describe('swipeTarget', () => {
  const W = 400;
  it('moves on a long swipe, or a short fast one', () => {
    expect(swipeTarget(1, 3, -150, 0, W)).toBe(2);
    expect(swipeTarget(1, 3, 150, 0, W)).toBe(0);
    expect(swipeTarget(1, 3, -40, -0.8, W)).toBe(2);
  });
  it('stays on a short slow swipe, or a tiny flick', () => {
    expect(swipeTarget(1, 3, -60, -0.1, W)).toBe(1);
    expect(swipeTarget(1, 3, -10, -2, W)).toBe(1);
  });
  it("doesn't go past the first or last", () => {
    expect(swipeTarget(0, 3, 300, 1, W)).toBe(0);
    expect(swipeTarget(2, 3, -300, -1, W)).toBe(2);
  });
});

describe('MediaViewer paging', () => {
  let clock = 1;
  const touch = (x: number) => {
    const at = (clock += 16);
    const t = { pageX: x, pageY: 400, locationX: x, locationY: 400, identifier: 0, timestamp: at };
    return {
      nativeEvent: { touches: [t], changedTouches: [t], pageX: x, pageY: 400, timestamp: at },
      touchHistory: {
        numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: at,
        touchBank: [{ touchActive: true, startPageX: x, startPageY: 400, startTimeStamp: at, currentPageX: x, currentPageY: 400, currentTimeStamp: at, previousPageX: x, previousPageY: 400, previousTimeStamp: at }],
      },
    };
  };
  const items: ViewerItem[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, url: `file:///${id}.jpg`, type: 'image', senderName: id.toUpperCase() }));

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Image, 'getSize').mockImplementation((_u, ok) => ok(1600, 1200));
  });
  afterEach(() => jest.useRealTimers());

  const open = (index: number) => {
    let tree!: ReactTestRenderer;
    act(() => { tree = renderer.create(<MediaViewer items={items} index={index} onClose={jest.fn()} />); });
    return tree;
  };
  const header = (tree: ReactTestRenderer) => tree.root.findAllByType(Text).map((t) => t.props.children).flat().join('|');
  const activePage = (tree: ReactTestRenderer) => tree.root.findAllByType(ZoomableImage).find((z) => z.props.active)!;
  const swipe = (tree: ReactTestRenderer, xs: number[]) => {
    const view = () => activePage(tree).findAll((n) => typeof n.props.onResponderGrant === 'function')[0];
    act(() => view().props.onResponderGrant(touch(xs[0])));
    for (const x of xs.slice(1)) act(() => view().props.onResponderMove(touch(x)));
    act(() => view().props.onResponderRelease(touch(xs[xs.length - 1])));
    act(() => { jest.advanceTimersByTime(1000); });
  };

  it('only the photo on screen and its neighbours are made', () => {
    const tree = open(1);
    expect(tree.root.findAllByType(ZoomableImage).map((z) => z.props.uri)).toEqual(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']);
    expect(header(tree)).toContain('2 of 4');
  });

  it('swiping left and right moves between photos, and stops at the ends', () => {
    const tree = open(1);
    swipe(tree, [300, 250, 150, 100]);
    expect(header(tree)).toContain('3 of 4');
    expect(activePage(tree).props.uri).toBe('file:///c.jpg');
    swipe(tree, [300, 250, 150, 50]);
    expect(header(tree)).toContain('4 of 4');
    swipe(tree, [300, 250, 150, 50]); // the last one: stays
    expect(header(tree)).toContain('4 of 4');
    swipe(tree, [100, 150, 250, 300]);
    expect(header(tree)).toContain('3 of 4');
  });

  it('a short slow drag springs back to the same photo', () => {
    const tree = open(0);
    swipe(tree, [300, 296, 292, 288, 284, 280, 276]); // 4 px a frame: 250 px/s
    expect(header(tree)).toContain('1 of 4');
  });
});
