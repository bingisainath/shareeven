// src/screens/chats/SharedMediaScreen.tsx
// "Media, links and docs" from chat info: everything shared in the chat, newest first.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Download, FileText, Link2, Play } from 'lucide-react-native';
import MediaViewer, { ViewerItem } from '../../components/chat/MediaViewer';
import VoiceNote from '../../components/chat/VoiceNote';
import { api, errorMessage } from '../../api/client';
import { openText } from '../../crypto/messages';
import { useMediaSrc } from '../../crypto/media';
import { isV2Marker, localFor } from '../../crypto/v2-platform/chat';
import { useAuth } from '../../store/auth';
import { colors, space } from '../../theme';
import { formatDuration, formatSize } from '../../utils/time';
import { saveWithFeedback } from '../../utils/save';
import { downloadLabel, useDownloadOf } from '../../store/downloads';
import type { AppStackParams } from '../../navigation/types';
import { Segmented } from '../expenses/AddExpenseScreen';
import { showAlert } from '../../components/common/Dialog';

type Kind = 'media' | 'docs' | 'links';
interface Item {
  message_id: string;
  sender_id: string;
  sender_name?: string | null;
  created_at: string;
  media_type?: 'image' | 'video' | 'audio' | 'file';
  media_url?: string;
  media_thumbnail?: string | null;
  media_filename?: string | null;
  media_size?: number | null;
  media_duration?: number | null;
  url?: string;
  text?: string | null;
  encrypted?: boolean;
  // End-to-end encrypted items (from the decrypted message)
  media_key?: string;
  media_mime?: string;
  thumb_key?: string;
  media_v2?: { sha256: string; size: number }; // v2 files (PMV2)
  thumb_v2?: { sha256: string; size: number };
}

/** v2 items: the server only knows something was shared; details and keys come from this phone's copy. */
async function fillV2Items(items: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const item of items) {
    if (!isV2Marker(item.text)) {
      out.push(item);
      continue;
    }
    const local = await localFor(item.message_id).catch(() => null);
    if (!local || local.deleted) continue; // not on this phone
    if (item.encrypted) { // a Links-tab item: list the links in our copy of the text
      const urls = Array.from(new Set((local.text || '').match(URL_RE) || [])).map((u) => u.replace(/[.,);!?]+$/, ''));
      urls.forEach((url) => out.push({ ...item, url, text: local.text }));
      continue;
    }
    const p = local.media?.[0];
    if (!p) continue;
    out.push({
      ...item, text: local.text, media_key: p.key, media_mime: p.mime, media_filename: p.name ?? null, media_size: p.size,
      media_duration: p.dur ?? null, media_v2: { sha256: p.sha256, size: p.size },
      ...(p.thumb ? { thumb_key: p.thumb.key, thumb_v2: { sha256: p.thumb.sha256, size: p.thumb.size } } : {}),
    });
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Fill in what the server can't see for end-to-end encrypted items (names, keys, links). */
function decryptItems(conversationId: string, items: Item[]): Item[] {
  return items.flatMap((item) => {
    const opened = openText(item.text, conversationId, item.sender_id);
    if (!opened) return [item];
    if (!opened.ok) return item.encrypted ? [] : [item];
    if (item.encrypted) {
      const urls = Array.from(new Set(opened.text.match(URL_RE) || [])).map((u) => u.replace(/[.,);!?]+$/, ''));
      return urls.map((url) => ({ ...item, url, text: opened.text }));
    }
    const m = opened.media;
    return [m ? {
      ...item, text: opened.text, media_key: m.key, media_mime: m.mime, thumb_key: m.tk,
      media_filename: m.name ?? null, media_size: m.size ?? null, media_duration: m.d ?? null,
    } : item];
  });
}

/** A photo or video thumbnail, decrypted first if it's end-to-end encrypted. */
const Thumb: React.FC<{ item: Item; size: number }> = ({ item, size }) => {
  const video = item.media_type === 'video';
  const { src } = useMediaSrc(video ? item.media_thumbnail || undefined : item.media_url, video ? item.thumb_key : item.media_key, video ? 'image/jpeg' : item.media_mime, video ? item.thumb_v2 : item.media_v2);
  return src ? <Image source={{ uri: src }} style={{ width: size, height: size }} /> : <View style={{ width: size, height: size }} />;
};

/** A file's Save button: spins (with how far) while it downloads. */
const SaveFileButton: React.FC<{ item: Item }> = ({ item }) => {
  const download = useDownloadOf(item.media_url);
  if (download) {
    return (
      <View style={styles.saving} accessibilityLabel={downloadLabel(download)}>
        <ActivityIndicator size="small" color={colors.primary700} />
        {download.progress !== undefined && <Text style={styles.sub}>{Math.floor(download.progress * 100)}%</Text>}
      </View>
    );
  }
  return (
    <Pressable onPress={() => saveWithFeedback(item.media_url!, item.media_filename || 'file', item.media_key, item.media_mime, item.media_v2)}
      hitSlop={10} accessibilityLabel="Save to phone">
      <Download size={20} color={colors.primary700} />
    </Pressable>
  );
};

const SharedVoiceNote: React.FC<{ item: Item }> = ({ item }) => {
  const { src, failed } = useMediaSrc(item.media_url, item.media_key, item.media_mime, item.media_v2);
  if (!src) return <Text style={styles.sub}>{failed ? "Couldn't decrypt this voice message" : 'Decrypting…'}</Text>;
  return <VoiceNote uri={src} duration={item.media_duration || undefined} mine={false} />;
};

const SharedMediaScreen: React.FC<NativeStackScreenProps<AppStackParams, 'SharedMedia'>> = ({ route }) => {
  const { conversationId } = route.params;
  const me = useAuth((s) => s.user)!;
  const { width } = useWindowDimensions();
  const [kind, setKind] = useState<Kind>('media');
  const [items, setItems] = useState<Item[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<number | null>(null);

  const load = useCallback(async (more = false) => {
    setLoading(true);
    try {
      const before = more ? items[items.length - 1]?.created_at : undefined;
      const r = await api.get(`/conversations/${conversationId}/shared`, { params: { kind, before, limit: 60 } });
      const page = await fillV2Items(decryptItems(conversationId, r.data.data));
      setItems((current) => (more ? [...current, ...page] : page));
      setHasMore(!!r.data.has_more);
    } catch (e) {
      showAlert("Couldn't load", errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [conversationId, kind, items]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setItems([]); load(false); }, [conversationId, kind]);

  const viewerItems: ViewerItem[] = items
    .filter((i) => i.media_type === 'image' || i.media_type === 'video')
    .map((i) => ({
      id: i.message_id, url: i.media_url!, type: i.media_type as 'image' | 'video', filename: i.media_filename || undefined,
      mediaKey: i.media_key, mediaMime: i.media_mime, mediaV2: i.media_v2,
      senderName: i.sender_id === me.id ? 'You' : i.sender_name || undefined, timestamp: i.created_at,
    }));
  const tile = (width - 4) / 3;
  const who = (i: Item) => `${i.sender_id === me.id ? 'You' : i.sender_name || 'Someone'} · ${new Date(i.created_at).toLocaleDateString()}`;

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <Segmented value={kind} options={[['media', 'Media'], ['docs', 'Docs'], ['links', 'Links']]} onChange={(v) => setKind(v as Kind)} />
      </View>
      <FlatList
        key={kind}
        data={items}
        numColumns={kind === 'media' ? 3 : 1}
        keyExtractor={(i, n) => `${i.message_id}-${n}`}
        columnWrapperStyle={kind === 'media' ? { gap: 2 } : undefined}
        contentContainerStyle={{ gap: kind === 'media' ? 2 : 0 }}
        onEndReached={() => hasMore && !loading && load(true)}
        ListEmptyComponent={loading ? null : (
          <Text style={styles.empty}>{kind === 'media' ? 'No photos or videos yet' : kind === 'docs' ? 'No documents or voice messages yet' : 'No links yet'}</Text>
        )}
        ListFooterComponent={loading ? <ActivityIndicator style={{ margin: space(6) }} color={colors.primary700} /> : null}
        renderItem={({ item }) => {
          if (kind === 'media') {
            const index = viewerItems.findIndex((v) => v.id === item.message_id);
            return (
              <Pressable onPress={() => setViewer(index)} style={{ width: tile, height: tile, backgroundColor: colors.muted100 }}>
                <Thumb item={item} size={tile} />
                {item.media_type === 'video' && (
                  <View style={styles.videoBadge}><Play size={11} color={colors.white} fill={colors.white} /><Text style={styles.videoText}>{formatDuration(item.media_duration)}</Text></View>
                )}
              </Pressable>
            );
          }
          if (kind === 'links') {
            return (
              <Pressable onPress={() => Linking.openURL(item.url!)} style={styles.row}>
                <View style={styles.icon}><Link2 size={20} color={colors.primary700} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.link} numberOfLines={1}>{item.url}</Text>
                  <Text style={styles.sub}>{who(item)}</Text>
                </View>
              </Pressable>
            );
          }
          return (
            <View style={styles.row}>
              {item.media_type === 'audio' ? (
                <View style={{ flex: 1 }}>
                  <Text style={styles.sub}>{who(item)}</Text>
                  <SharedVoiceNote item={item} />
                </View>
              ) : (
                <>
                  <View style={styles.icon}><FileText size={20} color={colors.primary700} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>{item.media_filename || 'File'}</Text>
                    <Text style={styles.sub}>{formatSize(item.media_size)} · {who(item)}</Text>
                  </View>
                  <SaveFileButton item={item} />
                </>
              )}
            </View>
          );
        }}
      />
      <MediaViewer items={viewerItems} index={viewer} onClose={() => setViewer(null)} />
    </View>
  );
};

const styles = StyleSheet.create({
  saving: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  container: { flex: 1, backgroundColor: colors.white },
  tabs: { alignItems: 'center', paddingVertical: space(3) },
  empty: { textAlign: 'center', color: colors.muted500, marginTop: space(10) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.muted200 },
  icon: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.primary50, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 15, color: colors.muted900 },
  link: { fontSize: 14, color: colors.primary800 },
  sub: { fontSize: 12, color: colors.muted500, marginTop: 2 },
  videoBadge: { position: 'absolute', left: 4, bottom: 4, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 4, borderRadius: 4, backgroundColor: 'rgba(0,0,0,0.6)' },
  videoText: { color: colors.white, fontSize: 10 },
});

export default SharedMediaScreen;
