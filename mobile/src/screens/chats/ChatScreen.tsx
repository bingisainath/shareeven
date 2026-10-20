// src/screens/chats/ChatScreen.tsx
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ban, ChevronDown, Copy, CornerUpLeft, Download, Flag, Forward as ForwardIcon, Info, Lock, LockOpen, Pencil, ReceiptText, Search, ShieldAlert, Trash2, X } from 'lucide-react-native';
import ChatSearch from './ChatSearch';
import { useKeyChanges, useTrustActions } from '../../crypto/v2-platform/trust';
import { useChatEncryption } from '../../crypto/useChatEncryption';
import { SafeAreaView } from 'react-native-safe-area-context';
import Avatar from '../../components/common/Avatar';
import MessageBubble from '../../components/chat/MessageBubble';
import AlbumGrid, { groupAlbums } from '../../components/chat/AlbumGrid';
import Composer from '../../components/chat/Composer';
import ForwardSheet from '../../components/chat/ForwardSheet';
import MediaViewer, { ViewerItem } from '../../components/chat/MediaViewer';
import { saveToPhone } from '../../utils/save';
import { chatApi, Message, ReplyPreview } from '../../api/chat';
import { errorMessage } from '../../api/client';
import { safetyApi } from '../../api/safety';
import { chatDrafts } from '../../utils/drafts';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { useAuth } from '../../store/auth';
import { mediaPayloadOf, onScreen, typingNames, useChat } from '../../store/chat';
import { sealFor } from '../../crypto/messages';
import { editV2 } from '../../crypto/v2-platform/chat';
import { socket } from '../../websocket/socket';
import { colors, radius, space } from '../../theme';
import { dayLabel } from '../../utils/time';
import type { AppStackParams } from '../../navigation/types';
import { showAlert } from '../../components/common/Dialog';

const NO_MEMBERS: string[] = [];
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const TYPING_REPEAT_MS = 2500;
const EMPTY: Message[] = [];

type Row = { kind: 'message'; message: Message } | { kind: 'album'; messages: Message[] } | { kind: 'day'; label: string; key: string } | { kind: 'unread' };

const preview = (m: Message) =>
  m.text || (m.mediaType === 'image' ? 'Photo' : m.mediaType === 'video' ? 'Video' : m.mediaType === 'audio' ? 'Voice message' : m.mediaFilename || 'File');

const ChatScreen: React.FC<NativeStackScreenProps<AppStackParams, 'Chat'>> = ({ route, navigation }) => {
  const { conversationId } = route.params;
  const me = useAuth((s) => s.user)!;
  const conversation = useChat((s) => s.conversations.find((c) => c.id === conversationId));
  const messages = useChat((s) => s.messages[conversationId] ?? EMPTY);
  const hasMore = useChat((s) => !!s.hasMore[conversationId]);
  const typing = useChat((s) => s.typing);
  const online = useChat((s) => s.online);
  const { open, loadMessages, loadOlder, send, retry, sendMedia, cancelUpload, retryUpload, forward } = useChat.getState();

  const [text, setText] = useState('');
  // Unsent text for this chat comes back when you return to it
  useEffect(() => {
    let alive = true;
    chatDrafts.get(conversationId).then((draft) => { if (alive && draft) setText((t) => t || draft); });
    return () => { alive = false; };
  }, [conversationId]);
  const restoreDraft = () => { chatDrafts.get(conversationId).then(setText); };

  // The "New messages" line: above the oldest message that was unread when this chat opened
  const unreadAtOpen = useRef(conversation?.unreadCount || 0);
  const firstUnread = useRef<string | null>(null);
  if (!firstUnread.current && unreadAtOpen.current > 0 && messages.length) {
    const fromOthers = messages.filter((m) => m.senderId !== me.id && m.messageType !== 'system' && !m.id.startsWith('temp-'));
    firstUnread.current = fromOthers[Math.max(0, fromOthers.length - unreadAtOpen.current)]?.id ?? null;
  }
  const firstUnreadId = firstUnread.current;

  // Newer messages while reading further up: counted on a "new messages" button instead of a jump
  const offsetY = useRef(0);
  const openedAtLine = useRef(false);
  const [newBelow, setNewBelow] = useState(0);
  const [farFromNewest, setFarFromNewest] = useState(false);
  const newestId = messages[messages.length - 1]?.id;
  const lastNewestId = useRef(newestId);
  useEffect(() => {
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === lastNewestId.current) return;
    const wasKnown = lastNewestId.current !== undefined;
    lastNewestId.current = newest.id;
    if (wasKnown && offsetY.current > 160 && newest.senderId !== me.id) setNewBelow((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId]);
  const [replyTo, setReplyTo] = useState<ReplyPreview | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [selected, setSelected] = useState<Message | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [loading, setLoading] = useState(!messages.length);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastTypingSent = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const list = useRef<FlatList<Row>>(null);
  const keyboard = useKeyboardOffset(); // keeps the composer right above the keyboard

  // Join the room while the chat is on screen
  useFocusEffect(useCallback(() => {
    open(conversationId);
    loadMessages(conversationId).catch((e) => showAlert("Couldn't load messages", errorMessage(e))).finally(() => setLoading(false));
    return () => open(null);
  }, [conversationId, open, loadMessages]));

  // Tell the server we've read up to the newest message from someone else (only while the app is in
  // front: a chat left open in the background isn't being read; coming back reads it, see store/chat)
  const latestFromOthers = useMemo(() => [...messages].reverse().find((m) => m.senderId !== me.id && !m.id.startsWith('temp-')), [messages, me.id]);
  useEffect(() => {
    if (latestFromOthers && onScreen()) socket.read(conversationId, latestFromOthers.id);
  }, [latestFromOthers, conversationId]);

  const otherId = conversation && !conversation.isGroup ? conversation.members.find((id) => id !== me.id) : undefined;
  const typers = typingNames(typing, conversationId).filter(Boolean);
  const status = typers.length
    ? conversation?.isGroup ? `${typers.length > 1 ? `${typers.length} people are` : `${typers[0]} is`} typing…` : 'typing…'
    : conversation?.isGroup ? `${conversation.members.length} members` : otherId && online.includes(otherId) ? 'Online' : 'Offline';

  const encryption = useChatEncryption(conversationId);

  const keyChanges = useKeyChanges(conversation?.members || NO_MEMBERS);

  const trustActions = useTrustActions();
  const encrypted = encryption.state === 'encrypted';

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <Pressable onPress={() => navigation.navigate('ChatInfo', { conversationId })} style={styles.headerTitle} accessibilityLabel="Chat info">
          <Avatar uri={conversation?.avatar} name={conversation?.name} size={36} online={!!otherId && online.includes(otherId)} group={!!conversation?.isGroup} />
          <View style={styles.headerText}>
            <View style={styles.headerNameRow}>
              <Text style={styles.headerName} numberOfLines={1}>{conversation?.name || 'Chat'}</Text>
              {encrypted && <Lock size={12} color={colors.muted400} accessibilityLabel="End-to-end encrypted" />}
            </View>
            <Text style={[styles.headerStatus, typers.length > 0 && { color: colors.primary700 }]} numberOfLines={1}>{status}</Text>
          </View>
        </Pressable>
      ),
      headerRight: () => (
        <View style={styles.headerActions}>
          <Pressable onPress={() => setSearching(true)} hitSlop={8} accessibilityLabel="Search in this chat">
            <Search size={22} color={colors.primary700} />
          </Pressable>
          <Pressable onPress={() => navigation.navigate('AddExpense', { conversationId })} hitSlop={8} accessibilityLabel="Add expense">
            <ReceiptText size={22} color={colors.primary700} />
          </Pressable>
          <Pressable onPress={() => navigation.navigate('ChatInfo', { conversationId })} hitSlop={8} accessibilityLabel="Chat info">
            <Info size={22} color={colors.primary700} />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, conversation, conversationId, status, typers.length, otherId, online, encrypted]);

  // Newest first for the inverted list, with a day label above each day's first message
  const rows = useMemo<Row[]>(() => {
    const items = groupAlbums(messages);
    const firstOf = (item: (typeof items)[number]) => (item.kind === 'album' ? item.messages[0] : item.message);
    const out: Row[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      out.push(item);
      // (newest first: pushed after the message, so it's drawn just above it)
      const ids = item.kind === 'album' ? item.messages.map((x) => x.id) : [item.message.id];
      if (firstUnreadId && ids.includes(firstUnreadId)) out.push({ kind: 'unread' });
      const m = firstOf(item);
      const older = items[i - 1] ? firstOf(items[i - 1]) : null;
      if (!older || new Date(older.timestamp).toDateString() !== new Date(m.timestamp).toDateString()) {
        out.push({ kind: 'day', label: dayLabel(m.timestamp), key: `day-${m.timestamp}` });
      }
    }
    return out;
  }, [messages, firstUnreadId]);

  // Photos and videos of this chat, for the full-screen viewer
  const media = useMemo<ViewerItem[]>(() => messages
    .filter((m) => (m.mediaType === 'image' || m.mediaType === 'video') && m.mediaUrl && !m.isDeleted && !m.id.startsWith('temp-'))
    .map((m) => ({
      id: m.id, url: m.mediaUrl!, type: m.mediaType as 'image' | 'video', filename: m.mediaFilename, mediaKey: m.mediaKey, mediaMime: m.mediaMime, mediaV2: m.mediaV2,
      senderName: m.senderId === me.id ? 'You' : m.senderName, timestamp: m.timestamp,
    })), [messages, me.id]);
  const openMedia = (id: string) => {
    const index = media.findIndex((x) => x.id === id);
    if (index >= 0) setViewerIndex(index);
  };

  const save = async (m: Message) => {
    try {
      await saveToPhone(m.mediaUrl!, m.mediaFilename || `${m.mediaType}-${m.id.slice(0, 8)}`, m.mediaKey, m.mediaMime, m.mediaV2);
      if (Platform.OS === 'android') showAlert('Saving to Downloads', 'You\'ll get a notification when it\'s done.');
    } catch {
      showAlert("Couldn't save it", 'Check your connection and try again.');
    }
  };

  const onChangeText = (value: string) => {
    setText(value);
    if (!editing) chatDrafts.set(conversationId, value);
    const now = Date.now();
    if (now - lastTypingSent.current > TYPING_REPEAT_MS) {
      socket.typing(conversationId, true);
      lastTypingSent.current = now;
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => { socket.typing(conversationId, false); lastTypingSent.current = 0; }, 2000);
  };

  const submit = async () => {
    const value = text.trim();
    if (typingTimer.current) clearTimeout(typingTimer.current);
    socket.typing(conversationId, false);
    lastTypingSent.current = 0;
    if (editing) {
      const original = editing;
      setEditing(null);
      restoreDraft(); // back to what they were typing before editing
      if (!value || value === original.text) return;
      try {
        if (original.e2eVersion === 2) {
          // v2: the edit is a new encrypted packet to the same devices; the server row doesn't change
          await editV2({ conversationId, isGroup: !!conversation?.isGroup, members: conversation?.members || [] }, original, value);
          useChat.setState((s) => ({ messages: { ...s.messages, [conversationId]: (s.messages[conversationId] || []).map((m) => (m.id === original.id ? { ...m, text: value, editedAt: new Date().toISOString() } : m)) } }));
          return;
        }
        // Encrypted chat (v1): the edit is a new envelope (keeping the attached file's key)
        const sealed = await sealFor(conversationId, { t: value, m: mediaPayloadOf(original) });
        await chatApi.editMessage(original.id, sealed?.text ?? value, sealed?.hasLink);
      } catch (e) {
        showAlert("Couldn't edit message", errorMessage(e));
      }
      return;
    }
    if (!value) return;
    send(conversationId, value, { id: me.id, username: me.username }, replyTo);
    setText('');
    chatDrafts.clear(conversationId);
    setReplyTo(null);
  };

  const react = (message: Message, emoji: string) => {
    chatApi.react(message.id, emoji).catch((e) => showAlert("Couldn't react", errorMessage(e)));
  };

  const remove = (message: Message) => {
    showAlert('Delete message?', 'It will be deleted for everyone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => chatApi.deleteMessage(message.id).catch((e) => showAlert("Couldn't delete", errorMessage(e))),
      },
    ]);
  };

  const [highlighted, setHighlighted] = useState<string | null>(null);
  const jumpTo = (messageId: string): boolean => {
    const index = rows.findIndex((r) => (r.kind === 'message' && r.message.id === messageId) || (r.kind === 'album' && r.messages.some((m) => m.id === messageId)));
    if (index < 0) return false;
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setHighlighted(messageId);
    setTimeout(() => setHighlighted(null), 1600);
    return true;
  };

  // Opened from a search result (messageId): load older pages until the message is here, then show it
  const [target, setTarget] = useState<string | undefined>(route.params.messageId);
  useEffect(() => { if (route.params.messageId) setTarget(route.params.messageId); }, [route.params.messageId]);
  useEffect(() => {
    if (!target || loading) return;
    let cancelled = false;
    const has = () => (useChat.getState().messages[conversationId] || []).some((m) => m.id === target);
    (async () => {
      for (let page = 0; page < 40 && !cancelled && !has(); page++) {
        if (!useChat.getState().hasMore[conversationId]) break;
        await loadOlder(conversationId).catch(() => undefined);
      }
      if (cancelled) return;
      setTimeout(() => {
        if (!jumpToRef.current(target)) showAlert("Couldn't find that message in this chat any more.");
        setTarget(undefined);
        navigation.setParams({ messageId: undefined });
      }, 300);
    })();
    return () => { cancelled = true; };
  }, [target, loading, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;
  const [searching, setSearching] = useState(false);

  // The newest handlers, read when tapped: rows can keep the same callbacks and skip re-rendering
  const act = useRef({ setSelected, react, retry, openMedia, save, cancelUpload, retryUpload, jumpTo });
  act.current = { setSelected, react, retry, openMedia, save, cancelUpload, retryUpload, jumpTo };
  const openAlbumItem = useCallback((id: string) => act.current.openMedia(id), []);

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'day') return <Text style={styles.day}>{item.label}</Text>;
    if (item.kind === 'unread') {
      return (
        <View style={styles.unreadLine} accessibilityRole="text" accessibilityLabel="New messages">
          <View style={styles.unreadRule} /><Text style={styles.unreadText}>NEW MESSAGES</Text><View style={styles.unreadRule} />
        </View>
      );
    }
    if (item.kind === 'album') {
      return <AlbumGrid messages={item.messages} mine={item.messages[0].senderId === me.id} showSender={!!conversation?.isGroup} onOpen={openAlbumItem} />;
    }
    const m = item.message;
    const bubble = (
      <MessageBubble
        message={m}
        mine={m.senderId === me.id}
        showSender={!!conversation?.isGroup}
        currentUserId={me.id}
        // Through `act` (the latest handlers), so MessageBubble's memo can skip unchanged messages
        onLongPress={() => act.current.setSelected(m)}
        onReact={(emoji) => act.current.react(m, emoji)}
        onRetry={() => act.current.retry(conversationId, m.id)}
        onOpenMedia={() => act.current.openMedia(m.id)}
        onOpenFile={() => act.current.save(m)}
        onCancelUpload={() => act.current.cancelUpload(conversationId, m.id)}
        onRetryUpload={() => act.current.retryUpload(m.id)}
        onOpenExpense={(expenseId) => navigation.navigate('ExpenseDetail', { expenseId })}
        onJumpToReply={(id) => act.current.jumpTo(id)}
      />
    );
    return highlighted === m.id ? <View style={styles.highlight}>{bubble}</View> : bubble;
  };

  const loadMore = async () => {
    if (!hasMore || loadingOlder) return;
    setLoadingOlder(true);
    await loadOlder(conversationId).catch(() => undefined);
    setLoadingOlder(false);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {searching && (
        <ChatSearch conversationId={conversationId} currentUserId={me.id} onClose={() => setSearching(false)}
          onPick={(id) => { setSearching(false); setTarget(id); }} />
      )}
      <View ref={keyboard.ref} style={[styles.flex, { paddingBottom: keyboard.offset }]}>
        {/* Someone's security code changed (they started fresh): say so once; verified contacts must be accepted */}
        {keyChanges.map((t) => {
          const name = conversation?.isGroup ? (messages.find((m) => m.senderId === t.user)?.senderName || 'A member') : conversation?.name || 'They';
          return (
            <View key={t.user} style={[styles.keyChange, t.needsAccept && styles.keyChangeUrgent]}>
              <ShieldAlert size={14} color={t.needsAccept ? colors.danger600 : colors.primary700} />
              <View style={styles.flex}>
                <Text style={[styles.keyChangeText, t.needsAccept && { color: colors.danger600 }]}>
                  {t.needsAccept
                    ? `${name}'s security code changed. You'd verified them, so messages to them wait until you check the new code or accept it.`
                    : `${name}'s security code changed, probably because they started fresh on a new phone.`}
                </Text>
                <View style={styles.keyChangeActions}>
                  <Pressable onPress={() => navigation.navigate('ChatInfo', { conversationId })} hitSlop={6}><Text style={styles.keyChangeLink}>Compare codes</Text></Pressable>
                  <Pressable onPress={() => (t.needsAccept ? trustActions.accept(t.user) : trustActions.dismiss(t.user))} hitSlop={6}>
                    <Text style={styles.keyChangeLink}>{t.needsAccept ? 'Accept' : 'OK'}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
        })}
        {encryption.state === 'not-encrypted' && (
          <View style={styles.notEncrypted}>
            <LockOpen size={14} color={colors.warning700} />
            <Text style={styles.notEncryptedText}>
              {conversation?.isGroup
                ? `Not end-to-end encrypted yet: ${encryption.missing.length} member${encryption.missing.length === 1 ? " hasn't" : "s haven't"} set up encryption. New messages will be encrypted once everyone has.`
                : `Not end-to-end encrypted yet: ${conversation?.name || 'they'} hasn't set up encryption. New messages will be encrypted once they do.`}
            </Text>
          </View>
        )}
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary700} /></View>
        ) : (
          <FlatList
            ref={list}
            data={rows}
            inverted
            keyExtractor={(r) => (r.kind === 'day' ? r.key : r.kind === 'unread' ? 'unread-line' : r.kind === 'album' ? `album-${r.messages[0].id}` : r.message.id)}
            renderItem={renderRow}
            onEndReached={loadMore}
            onEndReachedThreshold={0.3}
            onScrollToIndexFailed={(info) => {
              // Far up the list and not measured yet: get close first, then aim again
              list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
              setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 120);
            }}
            ListFooterComponent={loadingOlder ? <ActivityIndicator style={{ margin: space(3) }} color={colors.primary700} /> : null}
            ListEmptyComponent={<Text style={styles.day}>No messages yet. Say hello.</Text>}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            // Reading older messages: new ones don't move what you're looking at; near the newest, they scroll in
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 160 }}
            onScroll={(e) => {
              offsetY.current = e.nativeEvent.contentOffset.y; // inverted: 0 is the newest message
              const far = offsetY.current > e.nativeEvent.layoutMeasurement.height;
              if (far !== farFromNewest) setFarFromNewest(far);
              if (offsetY.current < 160 && newBelow) setNewBelow(0);
            }}
            scrollEventThrottle={100}
            onLayout={() => {
              // Opened with lots unread: start at the "New messages" line instead of the newest message
              if (openedAtLine.current) return;
              openedAtLine.current = true;
              const index = rows.findIndex((r) => r.kind === 'unread');
              if (index > 8) setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.75, animated: false }), 50);
            }}
          />
        )}
        {(newBelow > 0 || farFromNewest) && !loading && (
          <Pressable
            onPress={() => { list.current?.scrollToOffset({ offset: 0, animated: true }); setNewBelow(0); }}
            style={styles.newBelow}
            accessibilityRole="button"
            accessibilityLabel={newBelow > 0 ? `${newBelow} new message${newBelow === 1 ? '' : 's'}, go to the newest` : 'Go to the newest message'}
          >
            <ChevronDown size={18} color={colors.primary700} />
            {newBelow > 0 && <Text style={styles.newBelowText}>{newBelow} new</Text>}
          </Pressable>
        )}

        {(replyTo || editing) && (
          <View style={styles.banner}>
            <View style={styles.flex}>
              <Text style={styles.bannerTitle}>{editing ? 'Editing message' : `Replying to ${replyTo?.senderName || 'message'}`}</Text>
              {!editing && <Text style={styles.bannerText} numberOfLines={1}>{replyTo?.text}</Text>}
            </View>
            <Pressable onPress={() => { setReplyTo(null); if (editing) { setEditing(null); restoreDraft(); } }} hitSlop={10} accessibilityLabel="Cancel">
              <X size={18} color={colors.muted500} />
            </Pressable>
          </View>
        )}

        {conversation?.isBlocked && conversation.otherUserId ? (
          <View style={styles.blocked}>
            <Ban size={18} color={colors.muted500} />
            <Text style={styles.blockedText}>You blocked {conversation.name}. You can't message each other.</Text>
            <Pressable onPress={() => {
              const userId = conversation.otherUserId!;
              safetyApi.unblock(userId).then(() => useChat.getState().setBlocked(userId, false))
                .catch((e) => showAlert("Couldn't unblock", errorMessage(e)));
            }} hitSlop={8} accessibilityLabel={`Unblock ${conversation.name}`}>
              <Text style={styles.blockedAction}>Unblock</Text>
            </Pressable>
          </View>
        ) : (
        <Composer
          text={text}
          onChangeText={onChangeText}
          editing={!!editing}
          onSendText={submit}
          onSendAttachments={(attachments) => {
            attachments.forEach((a, i) => sendMedia(conversationId, a, { id: me.id, username: me.username }, i === 0 ? replyTo : null));
            setReplyTo(null);
          }}
          onSendVoice={(a) => { sendMedia(conversationId, a, { id: me.id, username: me.username }, replyTo); setReplyTo(null); }}
        />
        )}
      </View>

      {/* Long-press menu */}
      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSelected(null)}>
          {selected && (
            <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
              <View style={styles.quickReactions}>
                {QUICK_REACTIONS.map((emoji) => (
                  <Pressable key={emoji} onPress={() => { react(selected, emoji); setSelected(null); }} style={styles.quickReaction} accessibilityLabel={`React ${emoji}`}>
                    <Text style={styles.quickReactionText}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
              <SheetAction icon={CornerUpLeft} label="Reply" onPress={() => {
                setEditing(null);
                setReplyTo({ id: selected.id, text: preview(selected), senderId: selected.senderId, senderName: selected.senderId === me.id ? 'yourself' : selected.senderName });
                setSelected(null);
              }} />
              {!!selected.text && <SheetAction icon={Copy} label="Copy text" onPress={() => { Clipboard.setString(selected.text); setSelected(null); }} />}
              <SheetAction icon={ForwardIcon} label="Forward" onPress={() => { setForwarding(selected); setSelected(null); }} />
              {!!selected.mediaUrl && <SheetAction icon={Download} label="Save to phone" onPress={() => { const m = selected; setSelected(null); save(m); }} />}
              {selected.senderId === me.id && !!selected.text && (
                <SheetAction icon={Pencil} label="Edit" onPress={() => { setReplyTo(null); setEditing(selected); setText(selected.text); setSelected(null); }} />
              )}
              {selected.senderId !== me.id && (
                <SheetAction icon={Flag} label="Report" danger onPress={() => {
                  const m = selected;
                  setSelected(null);
                  navigation.navigate('Report', {
                    title: 'Report this message', userId: m.senderId, userName: m.senderName, conversationId,
                    messageId: m.id, messageText: m.text || undefined,
                  });
                }} />
              )}
              {selected.senderId === me.id && (
                <SheetAction icon={Trash2} label="Delete for everyone" danger onPress={() => { const m = selected; setSelected(null); remove(m); }} />
              )}
            </Pressable>
          )}
        </Pressable>
      </Modal>

      {/* Photos and videos */}
      <MediaViewer
        items={media}
        index={viewerIndex}
        onClose={() => setViewerIndex(null)}
        onForward={(id) => { const m = messages.find((x) => x.id === id); setViewerIndex(null); if (m) setForwarding(m); }}
      />

      <ForwardSheet
        visible={!!forwarding}
        onClose={() => setForwarding(null)}
        onSend={async (ids) => {
          if (!forwarding) return;
          const { sent, skipped } = await forward(forwarding, ids).catch(() => ({ sent: 0, skipped: 0 }));
          const notes = [
            sent ? (sent === 1 ? 'Forwarded' : `Forwarded to ${sent} chats`) : '',
            skipped ? `Not forwarded to ${skipped === 1 ? 'a chat' : `${skipped} chats`} that isn't end-to-end encrypted yet` : '',
          ].filter(Boolean);
          showAlert(notes.join('. ') || 'Not connected. Try again.');
        }}
      />
    </SafeAreaView>
  );
};

const SheetAction: React.FC<{ icon: React.ComponentType<{ size?: number; color?: string }>; label: string; onPress: () => void; danger?: boolean }> = ({ icon: Icon, label, onPress, danger }) => (
  <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.muted50 }]}>
    <Icon size={20} color={danger ? colors.danger600 : colors.primary700} />
    <Text style={[styles.actionText, danger && { color: colors.danger600 }]}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  highlight: { backgroundColor: colors.primary100, borderRadius: radius.md },
  unreadLine: { flexDirection: 'row', alignItems: 'center', gap: space(2), marginHorizontal: space(4), marginVertical: space(2) },
  unreadRule: { flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: colors.primary300 },
  unreadText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: colors.primary600 },
  newBelow: {
    position: 'absolute', right: space(4), bottom: space(20), flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: space(3), height: 38, borderRadius: 19, backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.muted200, elevation: 4,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  newBelowText: { fontSize: 13, fontWeight: '700', color: colors.primary700 },
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingVertical: space(3) },
  day: { alignSelf: 'center', marginVertical: space(2), paddingHorizontal: space(3), paddingVertical: 3, borderRadius: radius.full, backgroundColor: colors.muted100, fontSize: 12, color: colors.muted600, overflow: 'hidden' },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), maxWidth: 230 },
  headerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  notEncrypted: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(4), paddingVertical: space(2), backgroundColor: colors.warning50 },
  notEncryptedText: { flex: 1, fontSize: 12, color: colors.warning700 },
  headerText: { flexShrink: 1 },
  headerName: { flexShrink: 1, fontSize: 16, fontWeight: '600', color: colors.muted900 },
  headerStatus: { fontSize: 12, color: colors.muted500 },
  headerActions: { flexDirection: 'row', gap: space(5), alignItems: 'center' },
  keyChange: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(4), paddingVertical: space(2), backgroundColor: colors.primary50, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.primary200 },
  keyChangeUrgent: { backgroundColor: colors.danger50, borderBottomColor: colors.danger500 },
  keyChangeText: { fontSize: 12, color: colors.primary800 },
  keyChangeActions: { flexDirection: 'row', gap: space(5), marginTop: space(1.5) },
  keyChangeLink: { fontSize: 13, fontWeight: '700', color: colors.primary700 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginHorizontal: space(3), marginBottom: space(2), padding: space(2.5), borderLeftWidth: 4, borderLeftColor: colors.primary600, backgroundColor: colors.primary50, borderRadius: radius.md },
  blocked: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(4), paddingVertical: space(3.5),
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200, backgroundColor: colors.white },
  blockedText: { flex: 1, fontSize: 13, color: colors.muted600 },
  blockedAction: { fontSize: 14, fontWeight: '700', color: colors.primary700 },
  bannerTitle: { fontSize: 12, fontWeight: '700', color: colors.primary700 },
  bannerText: { fontSize: 14, color: colors.muted600 },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: space(8), paddingTop: space(3) },
  quickReactions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: space(4), paddingBottom: space(3), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.muted200 },
  quickReaction: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.muted50 },
  quickReactionText: { fontSize: 24 },
  action: { flexDirection: 'row', alignItems: 'center', gap: space(4), paddingHorizontal: space(6), paddingVertical: space(4) },
  actionText: { fontSize: 16, color: colors.muted900 },
});

export default ChatScreen;
