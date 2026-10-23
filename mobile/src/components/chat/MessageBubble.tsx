// src/components/MessageBubble.tsx
import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, CheckCheck, Clock, Download, FileText, Lock, Play, ReceiptText, RotateCw, ShieldAlert, X, XCircle } from 'lucide-react-native';
import { useMediaSrc } from '../../crypto/media';
import { UNREADABLE_TEXT } from '../../crypto/messages';
import type { Message } from '../../api/chat';
import { colors, radius, space } from '../../theme';
import { clockTime, formatDuration, formatSize } from '../../utils/time';
import { blurUri } from '../../utils/blurPreview';
import VoiceNote from './VoiceNote';
import { downloadLabel, useDownloadOf } from '../../store/downloads';
import Avatar from '../common/Avatar';

interface Props {
  message: Message;
  mine: boolean;
  showSender: boolean; // group chats: name + avatar on others' messages
  currentUserId: string;
  onLongPress: () => void;
  onReact: (emoji: string) => void;
  onRetry: () => void;
  onOpenMedia: () => void; // photo or video viewer
  onOpenFile: () => void;
  onCancelUpload: () => void;
  onRetryUpload: () => void;
  onOpenExpense: (expenseId: string) => void;
  onJumpToReply: (messageId: string) => void;
}

const MessageBubble: React.FC<Props> = ({
  message: m, mine, showSender, currentUserId, onLongPress, onReact, onRetry, onOpenMedia, onOpenFile, onOpenExpense, onJumpToReply,
  onCancelUpload, onRetryUpload,
}) => {
  // End-to-end encrypted media is downloaded and decrypted on the phone first (plain media: as is)
  const image = useMediaSrc(m.mediaType === 'image' ? m.mediaUrl : undefined, m.mediaKey, m.mediaMime, m.mediaV2);
  const poster = useMediaSrc(m.mediaType === 'video' ? m.mediaThumbnail : undefined, m.thumbKey, 'image/jpeg', m.thumbV2);
  const download = useDownloadOf(m.mediaType === 'file' ? m.mediaUrl : undefined); // saving this file: how far
  const audio = useMediaSrc(m.mediaType === 'audio' ? m.mediaUrl : undefined, m.mediaKey, m.mediaMime, m.mediaV2);

  if (m.messageType === 'system') {
    if (m.expenseId) {
      return (
        <Pressable onPress={() => onOpenExpense(m.expenseId!)} style={styles.expenseCard} accessibilityLabel={`Expense: ${m.text}`}>
          <View style={styles.expenseIcon}><ReceiptText size={18} color={colors.primary700} /></View>
          <Text style={styles.expenseText}>{m.text}</Text>
        </Pressable>
      );
    }
    return <Text style={styles.system}>{m.text}</Text>;
  }

  const fg = mine ? colors.white : colors.muted900;
  const sub = mine ? 'rgba(255,255,255,0.75)' : colors.muted400;
  const status = mine && !m.isDeleted ? statusIcon(m.status) : null;
  // Photos and videos fill the bubble with a thin frame; with no caption the time sits on the picture
  const unreadable = m.e2e === 'unreadable' || m.e2e === 'pending';
  const visual = !m.isDeleted && !unreadable && !!m.mediaUrl && (m.mediaType === 'image' || m.mediaType === 'video');
  const timeOnMedia = visual && !m.text;
  const box = mediaBox(m.mediaWidth, m.mediaHeight);
  const meta = (overlay: boolean) => (
    <View style={overlay ? styles.metaOverlay : [styles.meta, visual && styles.inset]} pointerEvents="none">
      {m.editedAt && !m.isDeleted && <Text style={[styles.metaText, { color: overlay ? colors.white : sub }]}>edited</Text>}
      <Text style={[styles.metaText, { color: overlay ? colors.white : sub }]}>{clockTime(m.timestamp)}</Text>
      {status}
    </View>
  );

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
      {showSender && !mine && <Avatar uri={m.senderAvatar} name={m.senderName} size={28} />}
      <View style={[styles.column, mine ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
        <Pressable
          onLongPress={m.isDeleted || m.id.startsWith('temp-') ? undefined : onLongPress}
          delayLongPress={300}
          style={[styles.bubble, mine ? styles.mine : styles.other, visual && styles.bubbleMedia]}
          accessibilityLabel={spoken(m, mine)}
          accessibilityHint="Long press for options"
        >
          {showSender && !mine && m.senderName && <Text style={[styles.sender, visual && styles.senderMedia]}>{m.senderName}</Text>}

          {m.isDeleted ? (
            <View style={styles.inline}>
              <XCircle size={14} color={sub} />
              <Text style={[styles.deleted, { color: sub }]}>{mine ? 'You deleted this message' : 'This message was deleted'}</Text>
            </View>
          ) : (
            <>
              {m.replyTo && (
                <Pressable onPress={() => onJumpToReply(m.replyTo!.id)} style={[styles.quote, mine ? styles.quoteMine : styles.quoteOther, visual && styles.quoteMedia]}>
                  <Text style={[styles.quoteName, { color: mine ? colors.white : colors.primary700 }]} numberOfLines={1}>
                    {m.replyTo.senderId === currentUserId ? 'You' : m.replyTo.senderName || 'Message'}
                  </Text>
                  <Text style={[styles.quoteText, { color: mine ? 'rgba(255,255,255,0.85)' : colors.muted600 }]} numberOfLines={2}>{m.replyTo.text}</Text>
                </Pressable>
              )}

              {unreadable && (
                <View style={styles.inline}>
                  <Lock size={14} color={sub} />
                  <Text style={[styles.deleted, { color: sub }]}>{m.e2e === 'pending' ? 'Waiting for this message…' : UNREADABLE_TEXT}</Text>
                </View>
              )}

              {visual && (
                <Pressable onPress={onOpenMedia} style={[styles.media, { width: box.width }, timeOnMedia && styles.mediaAlone]} accessibilityLabel={m.mediaType === 'video' ? 'Play video' : 'Open photo'}>
                  {(m.mediaType === 'image' ? image.src : poster.src) ? (
                    <Image
                      source={{ uri: (m.mediaType === 'image' ? image.src : poster.src)! }}
                      style={[styles.image, box]}
                      resizeMode="cover"
                    />
                  ) : m.mediaBlur && !(m.mediaType === 'image' && image.failed) ? (
                    // the tiny preview from inside the message, blurred, until the photo is decrypted
                    <Image source={{ uri: blurUri(m.mediaBlur)! }} style={[styles.image, box]} resizeMode="cover" blurRadius={12} />
                  ) : (
                    <View style={[styles.image, m.mediaType === 'video' && styles.videoPlaceholder, styles.pending, box]}>
                      {m.mediaType === 'image' && (image.failed
                        ? <Text style={[styles.metaText, { color: colors.muted500 }]}>Couldn't decrypt this photo</Text>
                        : !!m.mediaKey && <Lock size={20} color={colors.muted400} />)}
                    </View>
                  )}
                  {m.mediaType === 'video' && (
                    <View style={styles.playOverlay} pointerEvents="none">
                      <View style={styles.playButton}><Play size={24} color={colors.white} fill={colors.white} /></View>
                      {!!m.mediaDuration && <Text style={styles.videoTime}>{formatDuration(m.mediaDuration)}</Text>}
                    </View>
                  )}
                  {m.uploadProgress !== undefined && (
                    <UploadBadge progress={m.uploadProgress} onCancel={onCancelUpload} />
                  )}
                  {timeOnMedia && meta(true)}
                </Pressable>
              )}
              {m.mediaUrl && !unreadable && m.mediaType === 'audio' && (
                <View>
                  {audio.src ? (
                    <VoiceNote uri={audio.src} duration={m.mediaDuration} mine={mine} />
                  ) : (
                    <View style={styles.inline}>
                      <Lock size={14} color={sub} />
                      <Text style={[styles.deleted, { color: sub }]}>{audio.failed ? "Couldn't decrypt this voice message" : 'Decrypting…'}</Text>
                    </View>
                  )}
                  {m.uploadProgress !== undefined && <UploadBadge progress={m.uploadProgress} onCancel={onCancelUpload} inline />}
                </View>
              )}
              {m.mediaUrl && !unreadable && m.mediaType === 'file' && (
                <Pressable onPress={onOpenFile} disabled={m.uploadProgress !== undefined || !!download} style={[styles.file, mine ? styles.fileMine : styles.fileOther]}
                  accessibilityLabel={download ? downloadLabel(download) : `Save ${m.mediaFilename || 'file'}`}>
                  <FileText size={22} color={fg} />
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[styles.fileName, { color: fg }]} numberOfLines={1}>{m.mediaFilename || 'File'}</Text>
                    <Text style={[styles.fileSize, { color: sub }]}>
                      {m.uploadProgress !== undefined ? `Uploading ${m.uploadProgress}%` : download ? downloadLabel(download) : formatSize(m.mediaSize)}
                    </Text>
                  </View>
                  {m.uploadProgress !== undefined ? (
                    <Pressable onPress={onCancelUpload} hitSlop={8} accessibilityLabel="Cancel upload"><X size={18} color={fg} /></Pressable>
                  ) : download ? (
                    <ActivityIndicator size="small" color={fg} />
                  ) : (
                    <Download size={18} color={fg} />
                  )}
                </Pressable>
              )}

              {!!m.text && <Text style={[styles.text, { color: fg }, visual && styles.inset]}>{m.text}</Text>}
            </>
          )}

          {!timeOnMedia && meta(false)}
        </Pressable>

        {m.e2eUnverified && (
          <View style={styles.unverified}>
            <ShieldAlert size={13} color={colors.warning700} />
            <Text style={styles.unverifiedText}>Couldn't verify the sender</Text>
          </View>
        )}

        {m.status === 'failed' && mine && (
          m.uploadFailed ? (
            <View style={styles.retry}>
              <Text style={styles.retryText}>Not sent</Text>
              <Pressable onPress={onRetryUpload} hitSlop={6} style={styles.retryButton}>
                <RotateCw size={12} color={colors.primary700} />
                <Text style={styles.retryAction}>Retry</Text>
              </Pressable>
              <Pressable onPress={onCancelUpload} hitSlop={6}><Text style={styles.removeText}>Remove</Text></Pressable>
            </View>
          ) : (
            <Pressable onPress={onRetry} style={styles.retry} hitSlop={6}>
              <RotateCw size={12} color={colors.danger600} />
              <Text style={styles.retryText}>Not sent · Tap to retry</Text>
            </Pressable>
          )
        )}

        {m.reactions.length > 0 && !m.isDeleted && (
          <View style={styles.reactions}>
            {m.reactions.map((r) => {
              const own = r.userIds.includes(currentUserId);
              return (
                <Pressable key={r.emoji} onPress={() => onReact(r.emoji)} style={[styles.reaction, own && styles.reactionOwn]}
                  accessibilityLabel={`${r.emoji} ${r.userIds.length}${own ? ', yours' : ''}`}>
                  <Text style={styles.reactionText}>{r.emoji}{r.userIds.length > 1 ? ` ${r.userIds.length}` : ''}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
};

// The bubble takes the picture's own shape: wide pictures are full width and short, tall ones
// keep the full height and get narrower, so there are no bars beside or below the picture.
// Only very thin or very wide pictures are cropped (to the limits below).
const MEDIA = { maxWidth: 240, maxHeight: 320, minWidth: 150, minHeight: 110 };
function mediaBox(w?: number | null, h?: number | null) {
  if (!w || !h) return { width: MEDIA.maxWidth, height: 200 };
  const ratio = w / h;
  if (ratio >= MEDIA.maxWidth / MEDIA.maxHeight) {
    return { width: MEDIA.maxWidth, height: Math.max(MEDIA.minHeight, Math.round(MEDIA.maxWidth / ratio)) };
  }
  return { width: Math.max(MEDIA.minWidth, Math.round(MEDIA.maxHeight * ratio)), height: MEDIA.maxHeight };
}

const UploadBadge: React.FC<{ progress: number; onCancel: () => void; inline?: boolean }> = ({ progress, onCancel, inline }) => (
  <Pressable onPress={onCancel} hitSlop={8} style={inline ? styles.uploadInline : styles.upload} accessibilityLabel="Cancel upload">
    <Text style={styles.uploadText}>{progress >= 99 ? 'Processing' : `${progress}%`}</Text>
    <X size={14} color={colors.white} />
  </Pressable>
);

function statusIcon(status: Message['status']) {
  const muted = 'rgba(255,255,255,0.75)';
  switch (status) {
    case 'sending': return <Clock size={13} color={muted} />;
    case 'sent': return <Check size={14} color={muted} />;
    case 'delivered': return <CheckCheck size={14} color={muted} />;
    case 'read': return <CheckCheck size={14} color="#7dd3fc" />;
    case 'failed': return <XCircle size={13} color="#f6c3cb" />;
  }
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space(2), marginVertical: 3, paddingHorizontal: space(3) },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  column: { maxWidth: '80%' },
  bubble: { paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: space(1.5), borderRadius: radius.lg },
  mine: { backgroundColor: colors.primary700, borderBottomRightRadius: 4 },
  other: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200, borderBottomLeftRadius: 4 },
  sender: { fontSize: 12, fontWeight: '700', color: colors.primary700, marginBottom: 2 },
  text: { fontSize: 15.5, lineHeight: 21 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  deleted: { fontStyle: 'italic', fontSize: 14 },
  quote: { borderLeftWidth: 3, borderRadius: radius.sm, paddingHorizontal: space(2), paddingVertical: space(1), marginBottom: space(1.5) },
  quoteMine: { backgroundColor: 'rgba(255,255,255,0.15)', borderLeftColor: 'rgba(255,255,255,0.7)' },
  quoteOther: { backgroundColor: colors.muted50, borderLeftColor: colors.primary500 },
  quoteName: { fontSize: 12, fontWeight: '700' },
  quoteText: { fontSize: 13 },
  // Set each side explicitly: in React Native paddingTop/paddingHorizontal from `bubble` win over a plain `padding`
  bubbleMedia: { paddingTop: 3, paddingBottom: 3, paddingHorizontal: 3 },
  senderMedia: { marginHorizontal: 6, marginTop: 2 },
  quoteMedia: { marginBottom: 3 },
  inset: { paddingHorizontal: 6 },
  media: { borderRadius: radius.lg - 3, overflow: 'hidden', marginBottom: space(1) },
  mediaAlone: { marginBottom: 0 },
  image: { backgroundColor: colors.muted100 },
  metaOverlay: { position: 'absolute', right: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full, backgroundColor: 'rgba(0,0,0,0.45)' },
  file: { flexDirection: 'row', alignItems: 'center', gap: space(2), padding: space(2.5), borderRadius: radius.md, marginBottom: space(1), minWidth: 180 },
  fileMine: { backgroundColor: 'rgba(255,255,255,0.15)' },
  fileOther: { backgroundColor: colors.muted100 },
  fileName: { flexShrink: 1, fontSize: 14, fontWeight: '500' },
  fileSize: { fontSize: 11, marginTop: 1 },
  videoPlaceholder: { backgroundColor: colors.muted700 },
  pending: { alignItems: 'center', justifyContent: 'center' },
  unverified: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  unverifiedText: { fontSize: 11, color: colors.warning700 },
  playOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', paddingLeft: 3 },
  videoTime: { position: 'absolute', left: 8, bottom: 6, color: colors.white, fontSize: 11, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 },
  upload: { position: 'absolute', top: 6, right: 6, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, backgroundColor: 'rgba(0,0,0,0.6)' },
  uploadInline: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, backgroundColor: 'rgba(0,0,0,0.35)', marginTop: 4 },
  uploadText: { color: colors.white, fontSize: 11 },
  retryButton: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: colors.primary50 },
  retryAction: { fontSize: 12, color: colors.primary700, fontWeight: '600' },
  removeText: { fontSize: 12, color: colors.muted600 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2 },
  metaText: { fontSize: 10.5 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  retryText: { fontSize: 12, color: colors.danger600 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: -4 },
  reaction: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200 },
  reactionOwn: { backgroundColor: colors.primary50, borderColor: colors.primary300 },
  reactionText: { fontSize: 13 },
  system: { alignSelf: 'center', marginVertical: space(2), paddingHorizontal: space(3), paddingVertical: space(1), backgroundColor: colors.muted100, borderRadius: radius.full, fontSize: 12, color: colors.muted600, textAlign: 'center', maxWidth: '85%' },
  expenseCard: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: space(2.5), marginVertical: space(2), padding: space(3), maxWidth: '88%', backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.primary200 },
  expenseIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary50, alignItems: 'center', justifyContent: 'center' },
  expenseText: { flexShrink: 1, fontSize: 14, color: colors.muted900 },
});

// Re-render only when the message or how it's shown changes. The screen passes callbacks that read its
// latest handlers when called (ChatScreen `act`), so new callback objects on each render don't matter.
export default React.memo(MessageBubble, (a, b) =>
  a.message === b.message && a.mine === b.mine && a.showSender === b.showSender && a.currentUserId === b.currentUserId);

const STATUS_WORDS: Record<string, string> = { sending: 'sending', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'not sent' };

/** What a screen reader says for a message: who, what, when and (yours) its status. */
function spoken(m: Message, mine: boolean): string {
  const who = mine ? 'You' : m.senderName || 'Message';
  const what = m.isDeleted ? 'deleted message'
    : m.text || (m.mediaType === 'image' ? 'photo' : m.mediaType === 'video' ? 'video' : m.mediaType === 'audio' ? 'voice message' : m.mediaFilename || 'attachment');
  const status = mine && m.status ? `, ${STATUS_WORDS[m.status] || m.status}` : '';
  return `${who}: ${what}, ${clockTime(m.timestamp)}${status}`;
}
