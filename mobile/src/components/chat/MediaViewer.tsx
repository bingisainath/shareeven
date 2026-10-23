// src/components/MediaViewer.tsx
// Full-screen photos and videos (a chat's, or a receipt or profile photo): swipe between them,
// pinch or double-tap a photo to zoom, tap to hide the buttons, Save and Forward.
//
// The pages move with JavaScript touch handling, not a native scrolling list: a native pager took
// a two-finger pinch for a sideways scroll and stole it, so pinch-to-zoom never worked. Photos
// hand their swipes over (ZoomableImage onSwipe); videos and pages still decrypting use SwipeArea.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Download, Forward, X } from 'lucide-react-native';
import Video from 'react-native-video';
import { Lock } from 'lucide-react-native';
import { useMediaSrc } from '../../crypto/media';
import { saveWithFeedback } from '../../utils/save';
import { useDownloadOf } from '../../store/downloads';
import { clockTime } from '../../utils/time';
import ZoomableImage from './ZoomableImage';

export interface ViewerItem {
  id: string;
  url: string;
  type: 'image' | 'video';
  filename?: string;
  senderName?: string;
  timestamp?: string;
  mediaKey?: string; // end-to-end encrypted: decrypted on the phone
  mediaMime?: string;
  mediaV2?: { sha256: string; size: number };
}

interface Props {
  items: ViewerItem[];
  index: number | null;
  onClose: () => void;
  onForward?: (id: string) => void;
}

/** Where a swipe lands: the next or previous page when it went far or fast enough, else back. */
export function swipeTarget(current: number, count: number, dx: number, vx: number, width: number): number {
  if ((dx < -width * 0.25 || (vx < -0.4 && dx < -20)) && current < count - 1) return current + 1;
  if ((dx > width * 0.25 || (vx > 0.4 && dx > 20)) && current > 0) return current - 1;
  return current;
}

const MediaViewer: React.FC<Props> = ({ items, index, onClose, onForward }) => {
  const { width, height } = useWindowDimensions();
  const [current, setCurrent] = useState(index ?? 0);
  const [chrome, setChrome] = useState(true); // the top bar; a tap on a photo hides or shows it
  const [saving, setSaving] = useState(false);
  const item = items[current];
  const download = useDownloadOf(item?.url); // this photo or video saving: how far

  // The row of pages slides by `offset`: -current * width at rest, plus the finger while swiping
  const offset = useRef(new Animated.Value(-(index ?? 0) * width)).current;
  const at = useRef(current); // the page being moved to, ahead of the re-render
  const latest = useRef({ width, count: items.length });
  latest.current = { width, count: items.length };

  useEffect(() => {
    if (index === null) return;
    at.current = index;
    setCurrent(index);
    offset.setValue(-index * width);
    setChrome(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useEffect(() => offset.setValue(-at.current * width), [width, offset]); // turned sideways

  const onSwipe = useCallback((dx: number) => {
    const { width: w, count } = latest.current;
    const i = at.current;
    const pastEnd = (dx > 0 && i === 0) || (dx < 0 && i === count - 1);
    offset.setValue(-i * w + (pastEnd ? dx * 0.3 : dx));
  }, [offset]);

  const onSwipeEnd = useCallback((dx: number, vx: number) => {
    const { width: w, count } = latest.current;
    const target = swipeTarget(at.current, count, dx, vx, w);
    at.current = target;
    Animated.timing(offset, { toValue: -target * w, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    setCurrent(target);
  }, [offset]);

  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const save = async () => {
    if (!item || saving) return;
    setSaving(true);
    // No name (photos usually have none): the extension is added from the type when saving
    await saveWithFeedback(item.url, item.filename || (item.type === 'video' ? 'ShareEven video' : 'ShareEven photo'), item.mediaKey, item.mediaMime, item.mediaV2);
    setSaving(false);
  };

  return (
    <Modal visible={index !== null} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.row, { transform: [{ translateX: offset }] }]}>
          {items.map((media, i) => (
            // Only the page on screen and its neighbours exist (and load); they keep their place, so nothing jumps
            Math.abs(i - current) <= 1 ? (
              <View key={media.id} style={[styles.page, { left: i * width, width, height }]}>
                <ViewerPage media={media} width={width} height={height} active={i === current}
                  onTap={toggleChrome} onSwipe={onSwipe} onSwipeEnd={onSwipeEnd} />
              </View>
            ) : null
          ))}
        </Animated.View>
        {chrome && <SafeAreaView style={styles.top} edges={['top']}>
          <Pressable onPress={onClose} hitSlop={10} style={styles.icon} accessibilityLabel="Close"><X size={24} color="#fff" /></Pressable>
          <View style={styles.title}>
            <Text style={styles.name} numberOfLines={1}>{item?.senderName || ''}</Text>
            <Text style={styles.sub}>{[item?.timestamp && clockTime(item.timestamp), items.length > 1 && `${current + 1} of ${items.length}`].filter(Boolean).join(' · ')}</Text>
          </View>
          {onForward && item && (
            <Pressable onPress={() => onForward(item.id)} hitSlop={10} style={styles.icon} accessibilityLabel="Forward"><Forward size={22} color="#fff" /></Pressable>
          )}
          <Pressable onPress={save} disabled={saving} hitSlop={10} style={styles.icon} accessibilityLabel="Save to phone">
            {saving || download ? (
              <View style={styles.saving}>
                <ActivityIndicator size="small" color="#fff" />
                {download?.progress !== undefined && download.progress < 1 && <Text style={styles.sub}>{Math.floor(download.progress * 100)}%</Text>}
              </View>
            ) : <Download size={22} color="#fff" />}
          </Pressable>
        </SafeAreaView>}
      </View>
    </Modal>
  );
};

type SwipeProps = { onSwipe: (dx: number) => void; onSwipeEnd: (dx: number, vx: number) => void };

/** Sideways swipes over a video or a page still decrypting. Taps still reach the video's controls. */
const SwipeArea: React.FC<SwipeProps & { children: React.ReactNode }> = ({ onSwipe, onSwipeEnd, children }) => {
  const handlers = useRef({ onSwipe, onSwipeEnd });
  handlers.current = { onSwipe, onSwipeEnd };
  const responder = useMemo(() => PanResponder.create({
    // Capture: taken from the video player once the finger clearly moves sideways
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => handlers.current.onSwipe(g.dx),
    onPanResponderRelease: (_, g) => handlers.current.onSwipeEnd(g.dx, g.vx),
    onPanResponderTerminate: () => handlers.current.onSwipeEnd(0, 0),
    onPanResponderTerminationRequest: () => false,
  }), []);
  return <View style={styles.fill} {...responder.panHandlers}>{children}</View>;
};

const ViewerPage: React.FC<SwipeProps & { media: ViewerItem; width: number; height: number; active: boolean; onTap: () => void }> = ({
  media, width, height, active, onTap, onSwipe, onSwipeEnd,
}) => {
  // Neighbouring photos load too, so a swipe shows them at once (videos only when shown)
  const load = media.type === 'video' ? active : true;
  const { src, failed } = useMediaSrc(load ? media.url : undefined, media.mediaKey, media.mediaMime, media.mediaV2);
  if (src && media.type === 'image') {
    return <ZoomableImage uri={src} width={width} height={height} active={active} onTap={onTap} onSwipe={onSwipe} onSwipeEnd={onSwipeEnd} />;
  }
  return (
    <SwipeArea onSwipe={onSwipe} onSwipeEnd={onSwipeEnd}>
      {!src ? (
        <View style={styles.pending}>
          <Lock size={20} color="rgba(255,255,255,0.7)" />
          <Text style={styles.sub}>{failed ? "Couldn't decrypt it" : load ? 'Decrypting…' : ''}</Text>
        </View>
      ) : (
        <Video source={{ uri: src }} style={{ width, height: height * 0.75 }} controls resizeMode="contain" paused={!active} />
      )}
    </SwipeArea>
  );
};

const styles = StyleSheet.create({
  pending: { alignItems: 'center', gap: 8 },
  saving: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backdrop: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  row: { flex: 1 },
  page: { position: 'absolute', top: 0 },
  fill: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8, backgroundColor: 'rgba(0,0,0,0.45)' },
  icon: { padding: 10 },
  title: { flex: 1 },
  name: { color: '#fff', fontSize: 15, fontWeight: '600' },
  sub: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
});

export default MediaViewer;
