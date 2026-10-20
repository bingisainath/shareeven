// src/components/AlbumGrid.tsx
// Four or more photos sent together show as one 2x2 grid ("+3" on the last tile), like the web app.
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { CheckCheck, Lock } from 'lucide-react-native';
import { useMediaSrc } from '../../crypto/media';
import type { Message } from '../../api/chat';
import { colors, radius, space } from '../../theme';
import { clockTime } from '../../utils/time';
import { blurUri } from '../../utils/blurPreview';
import Avatar from '../common/Avatar';

export type ChatItem = { kind: 'message'; message: Message } | { kind: 'album'; messages: Message[] };

const GAP_MS = 2 * 60 * 1000;
const isAlbumPhoto = (m: Message) =>
  m.mediaType === 'image' && !!m.mediaUrl && !m.text && !m.isDeleted && !m.replyTo
  && m.e2e !== 'unreadable' && m.e2e !== 'pending' // no key yet: the tile would show the encrypted file
  && m.uploadProgress === undefined && !m.uploadFailed && m.messageType !== 'system' && !m.reactions.length;

/** Split a chat (oldest first) into single messages and albums. */
export function groupAlbums(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length >= 4) items.push({ kind: 'album', messages: run });
    else run.forEach((message) => items.push({ kind: 'message', message }));
    run = [];
  };
  for (const m of messages) {
    const prev = run[run.length - 1];
    if (isAlbumPhoto(m) && (!prev || (prev.senderId === m.senderId
        && new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() <= GAP_MS))) {
      run.push(m);
    } else {
      flush();
      if (isAlbumPhoto(m)) run.push(m);
      else items.push({ kind: 'message', message: m });
    }
  }
  flush();
  return items;
}

const AlbumGrid: React.FC<{ messages: Message[]; mine: boolean; showSender: boolean; onOpen: (id: string) => void }> = ({ messages, mine, showSender, onOpen }) => {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const extra = messages.length - 4;
  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
      {showSender && !mine && <Avatar uri={first.senderAvatar} name={first.senderName} size={28} />}
      <View style={[styles.bubble, mine ? styles.mine : styles.other]}>
        {showSender && !mine && first.senderName && <Text style={styles.sender}>{first.senderName}</Text>}
        <View style={styles.grid} accessibilityLabel={`${messages.length} photos`}>
          {messages.slice(0, 4).map((m, i) => (
            <Pressable key={m.id} onPress={() => onOpen(m.id)} style={styles.tile} accessibilityLabel={`Open photo ${i + 1} of ${messages.length}`}>
              <AlbumPhoto message={m} />
              {i === 3 && extra > 0 && (
                <View style={styles.more}><Text style={styles.moreText}>+{extra}</Text></View>
              )}
            </Pressable>
          ))}
          <View style={styles.meta} pointerEvents="none">
            <Text style={styles.time}>{clockTime(last.timestamp)}</Text>
            {mine && <CheckCheck size={14} color={last.status === 'read' ? '#7dd3fc' : colors.white} />}
          </View>
        </View>
      </View>
    </View>
  );
};

const AlbumPhoto: React.FC<{ message: Message }> = ({ message: m }) => {
  const { src } = useMediaSrc(m.mediaUrl, m.mediaKey, m.mediaMime, m.mediaV2);
  // Grey while the photo is decrypted, never the bubble's purple showing through
  if (src) return <Image source={{ uri: src }} style={styles.image} />;
  if (m.mediaBlur) return <Image source={{ uri: blurUri(m.mediaBlur)! }} style={styles.image} blurRadius={12} />;
  return <View style={[styles.image, styles.pending]}><Lock size={18} color={colors.muted400} /></View>;
};

const TILE = 120;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space(2), marginVertical: 3, paddingHorizontal: space(3) },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: { padding: 3, borderRadius: radius.lg },
  mine: { backgroundColor: colors.primary700, borderBottomRightRadius: 4 },
  other: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200, borderBottomLeftRadius: 4 },
  sender: { fontSize: 12, fontWeight: '700', color: colors.primary700, marginHorizontal: 6, marginTop: 2, marginBottom: 3 },
  grid: { width: TILE * 2 + 2, flexDirection: 'row', flexWrap: 'wrap', gap: 2, borderRadius: radius.lg - 3, overflow: 'hidden' },
  tile: { width: TILE, height: TILE, backgroundColor: colors.muted100 },
  image: { width: '100%', height: '100%', backgroundColor: colors.muted100 },
  pending: { alignItems: 'center', justifyContent: 'center' },
  more: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  moreText: { color: colors.white, fontSize: 24, fontWeight: '600' },
  meta: { position: 'absolute', right: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full, backgroundColor: 'rgba(0,0,0,0.45)' },
  time: { fontSize: 10.5, color: colors.white },
});

// The album's rows are rebuilt when any message changes; redraw only if one of its own photos did
export default React.memo(AlbumGrid, (a, b) =>
  a.mine === b.mine && a.showSender === b.showSender && a.onOpen === b.onOpen &&
  a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]));
