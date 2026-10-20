// src/screens/chats/ChatListScreen.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { Archive, ArrowLeft, BellOff, Lock, MessageSquarePlus, MessagesSquare, Pin, Search, UsersRound } from 'lucide-react-native';
import NoticesBanner from '../../components/common/NoticesBanner';
import { searchMessages } from '../../services/messageSearch';
import type { SearchHit } from '../../services/messageSearch';
import { chatApi, isMuted } from '../../api/chat';
import { errorMessage } from '../../api/client';
import { showAlert } from '../../components/common/Dialog';
import GroupAddIcon from '../../components/chat/GroupAddIcon';
import { SafeAreaView } from 'react-native-safe-area-context';
import Avatar from '../../components/common/Avatar';
import { Empty } from '../../components/common/ui';
import { useAuth } from '../../store/auth';
import { typingNames, useChat } from '../../store/chat';
import type { Conversation } from '../../api/chat';
import { colors, radius, space } from '../../theme';
import { listTime } from '../../utils/time';
import type { AppStackParams } from '../../navigation/types';

type Filter = 'all' | 'direct' | 'groups';

const ChatListScreen: React.FC = () => {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const me = useAuth((s) => s.user);
  const { conversations, loaded, online, typing, loadConversations } = useChat();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archived = conversations.filter((c) => c.isArchived);
  const archivedUnread = archived.filter((c) => c.unreadCount > 0).length;

  // Message search (2+ characters): the server's results plus this phone's encrypted chats
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      searchMessages(q).then((r) => { if (alive) setHits(r); }).catch(() => { if (alive) setHits([]); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query]);

  // Long press: pin, mute, archive (like WhatsApp)
  const actions = (c: Conversation) => {
    const run = (p: Promise<unknown>) => p.catch((e) => showAlert("Couldn't change it", errorMessage(e)));
    const muteMenu = () => showAlert(`Mute ${c.name}`, 'No notifications from this chat. You can still see new messages here.', [
      { text: 'For 8 hours', onPress: () => run(useChat.getState().mute(c.id, '8h')) },
      { text: 'For 1 week', onPress: () => run(useChat.getState().mute(c.id, '1w')) },
      { text: 'Always', onPress: () => run(useChat.getState().mute(c.id, 'always')) },
      { text: 'Cancel', style: 'cancel' },
    ]);
    showAlert(c.name, undefined, [
      ...(!c.isArchived ? [{ text: c.isPinned ? 'Unpin chat' : 'Pin chat', onPress: () => run(chatApi.pin(c.id, !c.isPinned).then(() => useChat.getState().setPinned(c.id, !c.isPinned))) }] : []),
      isMuted(c) ? { text: 'Unmute', onPress: () => run(useChat.getState().mute(c.id, null)) } : { text: 'Mute notifications', onPress: muteMenu },
      { text: c.isArchived ? 'Unarchive chat' : 'Archive chat', onPress: () => run(useChat.getState().archive(c.id, !c.isArchived)) },
      { text: 'Cancel', style: 'cancel' },
    ], { cancelable: true });
  };

  useFocusEffect(useCallback(() => { loadConversations().catch(() => undefined); }, [loadConversations]));

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const time = (v?: string | null) => (v ? new Date(v).getTime() : 0);
    return conversations
      .filter((c) => (q ? true : showArchived ? c.isArchived : !c.isArchived)) // searching looks everywhere
      .filter((c) => (filter === 'all' ? true : filter === 'groups' ? c.isGroup : !c.isGroup))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.lastMessage.toLowerCase().includes(q))
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || time(b.pinnedAt) - time(a.pinnedAt) || time(b.lastMessageTime) - time(a.lastMessageTime));
  }, [conversations, query, filter, showArchived]);

  const refresh = async () => {
    setRefreshing(true);
    await loadConversations().catch(() => undefined);
    setRefreshing(false);
  };

  // Rows get plain values (and the latest handlers through `act`), so a typing or online change
  // re-renders only the row it's about
  const act = useRef({ open: (id: string) => navigation.navigate('Chat', { conversationId: id }), actions });
  act.current = { open: (id: string) => navigation.navigate('Chat', { conversationId: id }), actions };
  const renderItem = ({ item }: { item: Conversation }) => {
    const other = !item.isGroup ? item.members.find((id) => id !== me?.id) : undefined;
    const typers = typingNames(typing, item.id);
    const preview = typers.length ? (item.isGroup ? `${typers[0]} is typing…` : 'typing…') : item.lastMessage || 'No messages yet';
    return <ChatRow item={item} preview={preview} typing={typers.length > 0} online={!!other && online.includes(other)} act={act} />;
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>YOUR SPACE</Text>
          <Text style={styles.title}>Chats</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => navigation.navigate('NewGroup')} hitSlop={8} style={styles.iconButton} accessibilityLabel="New group">
            <GroupAddIcon size={24} color={colors.primary700} />
          </Pressable>
          <Pressable onPress={() => navigation.navigate('NewChat')} hitSlop={8} style={styles.iconButton} accessibilityLabel="New chat">
            <MessageSquarePlus size={22} color={colors.primary700} />
          </Pressable>
        </View>
      </View>
      <View style={styles.search}>
        <Search size={18} color={colors.muted400} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search chats and messages" placeholderTextColor={colors.muted400} style={styles.searchInput} />
      </View>
      <View style={styles.filters}>
        {(['all', 'direct', 'groups'] as Filter[]).map((f) => (
          <Pressable key={f} onPress={() => setFilter(f)} style={[styles.chip, filter === f && styles.chipOn]} accessibilityState={{ selected: filter === f }}>
            <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>{f === 'all' ? 'All' : f === 'direct' ? 'Direct' : 'Groups'}</Text>
          </Pressable>
        ))}
      </View>
      <NoticesBanner onPress={() => navigation.navigate('Notices')} />
      <FlatList
        data={list}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary700]} />}
        contentContainerStyle={list.length === 0 && !hits?.length && styles.emptyList}
        ListHeaderComponent={query.trim() ? null : showArchived ? (
          <Pressable onPress={() => setShowArchived(false)} style={styles.archivedRow} accessibilityLabel="Back to chats">
            <ArrowLeft size={18} color={colors.primary700} /><Text style={styles.archivedBack}>Archived chats</Text>
          </Pressable>
        ) : archived.length > 0 ? (
          <Pressable onPress={() => setShowArchived(true)} style={styles.archivedRow} accessibilityLabel={`Archived, ${archived.length} chats`}>
            <Archive size={18} color={colors.muted500} />
            <Text style={styles.archivedText}>Archived</Text>
            <Text style={[styles.archivedCount, archivedUnread > 0 && { color: colors.primary700, fontWeight: '700' }]}>{archivedUnread || archived.length}</Text>
          </Pressable>
        ) : null}
        ListFooterComponent={hits && hits.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Messages</Text>
            {hits.map((h) => {
              const chat = conversations.find((c) => c.id === h.conversationId);
              const who = h.senderId && h.senderId === me?.id ? 'You' : h.senderName;
              return (
                <Pressable key={h.id} onPress={() => navigation.navigate('Chat', { conversationId: h.conversationId, messageId: h.id })}
                  style={({ pressed }) => [styles.hit, pressed && styles.pressed]}>
                  <View style={styles.rowTop}>
                    <Text style={styles.hitChat} numberOfLines={1}>{chat?.name || 'Chat'}</Text>
                    <Text style={styles.time}>{listTime(h.timestamp)}</Text>
                  </View>
                  <View style={styles.hitTextRow}>
                    {h.encrypted && <Lock size={12} color={colors.muted400} />}
                    <Text style={styles.preview} numberOfLines={2}>{who ? `${who}: ` : ''}{h.text}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        ListEmptyComponent={loaded ? (
          <Empty icon={MessagesSquare} title={query ? (hits?.length ? 'No chats found' : 'Nothing found') : showArchived ? 'No archived chats' : archived.length ? 'Your other chats are archived' : 'No conversations yet'} text={query || archived.length || showArchived ? undefined : 'Start a chat or create a group'} />
        ) : null}
      />
    </SafeAreaView>
  );
};

const ChatRow = React.memo<{
  item: Conversation;
  preview: string;
  typing: boolean;
  online: boolean;
  act: React.MutableRefObject<{ open: (id: string) => void; actions: (c: Conversation) => void }>;
}>(({ item, preview, typing, online, act }) => (
  <Pressable
    onPress={() => act.current.open(item.id)}
    onLongPress={() => act.current.actions(item)}
    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    accessibilityLabel={`${item.name}${item.unreadCount ? `, ${item.unreadCount} unread` : ''}`}
  >
    <Avatar uri={item.avatar} name={item.name} size={50} online={online} group={item.isGroup} />
    <View style={styles.rowBody}>
      <View style={styles.rowTop}>
        <View style={styles.nameRow}>
          {item.isGroup && <UsersRound size={14} color={colors.muted400} />}
          <Text style={[styles.name, item.unreadCount > 0 && styles.bold]} numberOfLines={1}>{item.name}</Text>
          {isMuted(item) && <BellOff size={14} color={colors.muted400} accessibilityLabel="Muted" />}
        </View>
        <Text style={[styles.time, item.unreadCount > 0 && { color: colors.primary700 }]}>{listTime(item.lastMessageTime)}</Text>
      </View>
      <View style={styles.rowTop}>
        <Text style={[styles.preview, typing && styles.typing]} numberOfLines={1}>{preview}</Text>
        <View style={styles.badges}>
          {item.isPinned && <Pin size={14} color={colors.muted400} />}
          {item.unreadCount > 0 && (
            <View style={[styles.badge, isMuted(item) && { backgroundColor: colors.muted400 }]}><Text style={styles.badgeText}>{item.unreadCount > 99 ? '99+' : item.unreadCount}</Text></View>
          )}
        </View>
      </View>
    </View>
  </Pressable>
));

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(5), paddingVertical: space(3) },
  archivedText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.muted700 },
  archivedBack: { fontSize: 15, fontWeight: '700', color: colors.primary700 },
  archivedCount: { fontSize: 14, color: colors.muted500 },
  sectionTitle: { paddingHorizontal: space(4), paddingTop: space(4), paddingBottom: space(1), fontSize: 12, fontWeight: '700', color: colors.muted500, textTransform: 'uppercase', letterSpacing: 0.5 },
  hit: { paddingHorizontal: space(4), paddingVertical: space(2.5), gap: 2 },
  hitChat: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.muted900 },
  hitTextRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space(4), paddingTop: space(4) },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.3, color: colors.primary500 },
  title: { marginTop: 2, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, color: colors.muted900 },
  headerActions: { flexDirection: 'row', gap: space(2) },
  iconButton: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: colors.muted200, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: space(2), marginHorizontal: space(4), marginTop: space(4), paddingHorizontal: space(3), borderRadius: 12, backgroundColor: colors.background },
  searchInput: { flex: 1, height: 42, fontSize: 15, color: colors.muted900 },
  filters: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(4), paddingVertical: space(3) },
  chip: { paddingHorizontal: space(3.5), paddingVertical: space(1.5), borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  chipOn: { backgroundColor: colors.primary100, borderColor: colors.primary100 },
  chipText: { fontSize: 13, color: colors.muted500, fontWeight: '600' },
  chipTextOn: { color: colors.primary700 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginHorizontal: space(2), paddingHorizontal: space(2.5), paddingVertical: space(3), borderRadius: 14 },
  pressed: { backgroundColor: colors.primary50 },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(2) },
  nameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  name: { flexShrink: 1, fontSize: 16, color: colors.muted900, fontWeight: '600' },
  bold: { fontWeight: '700' },
  time: { fontSize: 12, color: colors.muted400 },
  preview: { flex: 1, fontSize: 14, color: colors.muted500 },
  typing: { color: colors.primary700, fontStyle: 'italic' },
  badges: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: colors.primary700, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: '700' },
  emptyList: { flexGrow: 1 },
});

export default ChatListScreen;
