// src/screens/chats/ChatInfoScreen.tsx
// Group or contact info: members, admin actions (incl. editing the group), pin, leave, and the chat's expense settings.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { launchImageLibrary } from 'react-native-image-picker';
import { Archive, ArchiveRestore, Ban, Bell, Flag, BellOff, Camera, ChevronRight, Images, Info, LogOut, Pin, PinOff, Type, UserPlus, Wallet, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Avatar from '../../components/common/Avatar';
import EditableField from '../../components/common/EditableField';
import EncryptionInfo from '../../components/chat/EncryptionInfo';
import UserSearch from '../../components/chat/UserSearch';
import { Divider } from '../../components/common/ui';
import { isMuted, chatApi, ConversationDetails, MemberInfo } from '../../api/chat';
import { expenseService, ExpenseSettings } from '../../api/expenses';
import { api, errorMessage } from '../../api/client';
import { safetyApi } from '../../api/safety';
import { useAuth } from '../../store/auth';
import { useChat } from '../../store/chat';
import { colors, radius, space } from '../../theme';
import type { AppStackParams } from '../../navigation/types';
import CurrencyPicker from '../../components/expenses/CurrencyPicker';
import SplitRulesSection from '../../components/expenses/SplitRulesSection';
import { showAlert } from '../../components/common/Dialog';

const ChatInfoScreen: React.FC<NativeStackScreenProps<AppStackParams, 'ChatInfo'>> = ({ route, navigation }) => {
  const { conversationId, addMembers } = route.params;
  const me = useAuth((s) => s.user)!;
  const pinned = useChat((s) => !!s.conversations.find((c) => c.id === conversationId)?.isPinned);
  const chat = useChat((s) => s.conversations.find((c) => c.id === conversationId));
  const muted = isMuted(chat);
  const mutedLabel = !muted ? 'On' : new Date(chat!.mutedUntil!).getFullYear() > 2100 ? 'Muted always'
    : `Muted until ${new Date(chat!.mutedUntil!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  const muteMenu = () => showAlert('Notifications', muted ? mutedLabel : 'Mute this chat: no notifications, but new messages still appear here.', [
    ...(muted ? [{ text: 'Unmute', onPress: () => run(() => useChat.getState().mute(conversationId, null)) }] : []),
    { text: 'Mute for 8 hours', onPress: () => run(() => useChat.getState().mute(conversationId, '8h')) },
    { text: 'Mute for 1 week', onPress: () => run(() => useChat.getState().mute(conversationId, '1w')) },
    { text: 'Mute always', onPress: () => run(() => useChat.getState().mute(conversationId, 'always')) },
    { text: 'Cancel', style: 'cancel' },
  ], { cancelable: true });
  const [details, setDetails] = useState<ConversationDetails | null>(null);
  const [settings, setSettings] = useState<ExpenseSettings | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busyPhoto, setBusyPhoto] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([chatApi.details(conversationId), expenseService.settings(conversationId)]);
      setDetails(d);
      setSettings(s);
    } catch (e) {
      showAlert("Couldn't load info", errorMessage(e));
      navigation.goBack();
    }
  }, [conversationId, navigation]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (addMembers && details?.my_role === 'admin') setAdding(true); }, [addMembers, details]);

  if (!details) return <View style={styles.center}><ActivityIndicator color={colors.primary700} /></View>;

  const isGroup = details.kind === 'group';
  const isAdmin = details.my_role === 'admin';
  const other = details.members.find((m) => !m.is_me);
  const title = isGroup ? details.title : other?.name || other?.username;

  const blocked = !!chat?.isBlocked;
  const setBlock = (block: boolean) => {
    if (!other) return;
    const name = other.name || other.username;
    const change = () => run(async () => {
      await (block ? safetyApi.block(other.id) : safetyApi.unblock(other.id));
      useChat.getState().setBlocked(other.id, block);
    });
    if (!block) return change();
    showAlert(`Block ${name}?`, "You won't be able to message each other directly, and they can't add you to groups. They aren't told. Groups you share and shared expenses stay as they are.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: change },
    ]);
  };
  const report = () => navigation.navigate('Report', isGroup
    ? { title: `Report ${title || 'group'}`, conversationId }
    : { title: `Report ${title || 'this person'}`, userId: other?.id, userName: title || undefined, conversationId });

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
      useChat.getState().loadConversations().catch(() => undefined);
    } catch (e) {
      showAlert('Something went wrong', errorMessage(e));
    }
  };

  // Admins edit the group: each change saves on its own and posts a note in the chat (server side)
  const saveGroup = async (body: Parameters<typeof chatApi.updateGroup>[1]) => {
    await chatApi.updateGroup(conversationId, body);
    await load();
    useChat.getState().loadConversations().catch(() => undefined);
  };

  const changePhoto = () => showAlert('Group photo', undefined, [
    { text: 'Choose photo', onPress: pickPhoto },
    ...(details.avatar_url ? [{ text: 'Remove photo', style: 'destructive' as const, onPress: () => photoTask(() => saveGroup({ avatar_url: '' })) }] : []),
    { text: 'Cancel', style: 'cancel' as const },
  ]);

  const photoTask = async (action: () => Promise<unknown>) => {
    setBusyPhoto(true);
    try { await action(); } catch (e) { showAlert("Couldn't update the photo", errorMessage(e)); } finally { setBusyPhoto(false); }
  };

  const pickPhoto = async () => {
    const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1, maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    photoTask(async () => {
      const form = new FormData();
      form.append('file', { uri: asset.uri, type: asset.type || 'image/jpeg', name: asset.fileName || 'group.jpg' } as any);
      const r = await api.post('/media/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await saveGroup({ avatar_url: r.data.data.url });
    });
  };

  const memberActions = (member: MemberInfo) => {
    if (!isAdmin || member.is_me) return;
    showAlert(member.name || member.username, undefined, [
      member.role === 'admin'
        ? { text: 'Remove as admin', onPress: () => run(() => api.patch(`/conversations/${conversationId}/members/${member.id}`, { role: 'member' })) }
        : { text: 'Make group admin', onPress: () => run(() => api.patch(`/conversations/${conversationId}/members/${member.id}`, { role: 'admin' })) },
      { text: 'Remove from group', style: 'destructive', onPress: () => run(() => chatApi.removeMember(conversationId, member.id)) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const leave = () => showAlert('Leave this group?', 'You will stop receiving its messages.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Leave', style: 'destructive',
      onPress: async () => {
        try {
          await chatApi.leave(conversationId, me.id);
          await useChat.getState().loadConversations();
          navigation.popToTop();
        } catch (e) {
          showAlert("Couldn't leave", errorMessage(e));
        }
      },
    },
  ]);

  const updateSettings = async (patch: Partial<Omit<ExpenseSettings, 'can_edit'>>) => {
    try {
      setSettings(await expenseService.updateSettings(conversationId, patch));
    } catch (e) {
      showAlert("Couldn't save", errorMessage(e));
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView>
        <View style={styles.hero}>
          {isGroup && isAdmin ? (
            <Pressable onPress={changePhoto} accessibilityLabel="Change group photo">
              <Avatar uri={details.avatar_url} name={title} size={88} />
              <View style={styles.camera}>{busyPhoto ? <ActivityIndicator size="small" color={colors.white} /> : <Camera size={16} color={colors.white} />}</View>
            </Pressable>
          ) : (
            <Avatar uri={isGroup ? details.avatar_url : other?.avatar} name={title} size={88} />
          )}
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{isGroup ? `Group · ${details.members.length} members` : `@${other?.username}`}</Text>
          {!(isGroup && isAdmin) && (isGroup ? details.description : other?.bio) ? <Text style={styles.about}>{isGroup ? details.description : other?.bio}</Text> : null}
        </View>

        {isGroup && isAdmin && (
          <View style={styles.section}>
            <EditableField icon={Type} label="Group name" value={details.title || ''} max={100}
              validate={(v) => (v.trim() ? null : 'Enter a group name')} onSave={(t) => saveGroup({ title: t })} />
            <EditableField icon={Info} label="Description" value={details.description || ''} placeholder="Add a group description" max={500} multiline
              onSave={(d) => saveGroup({ description: d })} />
          </View>
        )}

        <View style={styles.section}>
          <EncryptionInfo conversationId={conversationId} otherId={isGroup ? undefined : other?.id} otherName={other?.name || other?.username} />
        </View>

        <View style={styles.section}>
          <Row icon={Images} label="Media, links and docs" onPress={() => navigation.navigate('SharedMedia', { conversationId })} />
          <Divider />
          <Row icon={Wallet} label="Balances & expenses" onPress={() => navigation.navigate('ChatExpenses', { conversationId })} />
          <Divider />
          <Row icon={muted ? BellOff : Bell} label="Notifications" value={mutedLabel} onPress={muteMenu} />
          <Divider />
          {!chat?.isArchived && (
            <>
              <Row icon={pinned ? PinOff : Pin} label={pinned ? 'Unpin chat' : 'Pin chat'} onPress={() => run(async () => {
                await chatApi.pin(conversationId, !pinned);
                useChat.getState().setPinned(conversationId, !pinned);
              })} />
              <Divider />
            </>
          )}
          <Row icon={chat?.isArchived ? ArchiveRestore : Archive} label={chat?.isArchived ? 'Unarchive chat' : 'Archive chat'}
            onPress={() => run(() => useChat.getState().archive(conversationId, !chat?.isArchived))} />
        </View>

        {settings && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Expenses</Text>
            <Pressable style={styles.settingRow} disabled={!settings.can_edit} onPress={() => setPicking(true)}>
              <Text style={styles.settingLabel}>Default currency</Text>
              <Text style={styles.settingValue}>{settings.default_currency}</Text>
            </Pressable>
            <Divider />
            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Simplify debts</Text>
                <Text style={styles.settingHint}>Fewest payments to settle up</Text>
              </View>
              <Switch value={settings.simplify_debts} disabled={!settings.can_edit} onValueChange={(v) => updateSettings({ simplify_debts: v })}
                trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white} />
            </View>
            {!settings.can_edit && <Text style={[styles.settingHint, { paddingHorizontal: space(4), paddingBottom: space(3) }]}>Only group admins can change these.</Text>}
            <Divider />
            <SplitRulesSection conversationId={conversationId} members={details.members} />
          </View>
        )}

        {isGroup && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{details.members.length} members</Text>
              {isAdmin && (
                <Pressable onPress={() => setAdding(true)} style={styles.addButton} hitSlop={8}>
                  <UserPlus size={16} color={colors.primary700} />
                  <Text style={styles.addText}>Add</Text>
                </Pressable>
              )}
            </View>
            {details.members.map((member, i) => (
              <View key={member.id}>
                {i > 0 && <Divider />}
                <Pressable onPress={() => memberActions(member)} style={styles.member}>
                  <Avatar uri={member.avatar} name={member.name || member.username} size={40} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberName}>{member.is_me ? 'You' : member.name || member.username}</Text>
                    <Text style={styles.settingHint}>@{member.username}</Text>
                  </View>
                  {member.role === 'admin' && <Text style={styles.adminBadge}>Admin</Text>}
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <View style={styles.section}>
          {!isGroup && other && (
            <>
              <Row icon={Ban} label={blocked ? `Unblock ${title}` : `Block ${title}`} danger={!blocked} onPress={() => setBlock(!blocked)} />
              <Divider />
            </>
          )}
          <Row icon={Flag} label={isGroup ? 'Report group' : `Report ${title}`} danger onPress={report} />
          {isGroup && (
            <>
              <Divider />
              <Row icon={LogOut} label="Leave group" danger onPress={leave} />
            </>
          )}
        </View>
      </ScrollView>

      <Modal visible={adding} animationType="slide" onRequestClose={() => setAdding(false)}>
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Add members</Text>
            <Pressable onPress={() => setAdding(false)} hitSlop={10} accessibilityLabel="Close"><X size={22} color={colors.muted600} /></Pressable>
          </View>
          <UserSearch
            exclude={details.members.map((m) => m.id)}
            onPick={(user) => {
              setAdding(false);
              run(() => chatApi.addMembers(conversationId, [user.id]));
            }}
          />
        </SafeAreaView>
      </Modal>

      <CurrencyPicker visible={picking} value={settings?.default_currency || 'EUR'} onClose={() => setPicking(false)}
        onPick={(code) => { setPicking(false); updateSettings({ default_currency: code }); }} />
    </SafeAreaView>
  );
};

const Row: React.FC<{ icon: React.ComponentType<{ size?: number; color?: string }>; label: string; value?: string; onPress: () => void; danger?: boolean }> = ({ icon: Icon, label, value, onPress, danger }) => (
  <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.muted50 }]}>
    <Icon size={20} color={danger ? colors.danger600 : colors.primary700} />
    <Text style={[styles.rowText, danger && { color: colors.danger600 }]}>{label}</Text>
    {!!value && <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>}
    {!danger && <ChevronRight size={18} color={colors.muted400} />}
  </Pressable>
);

const styles = StyleSheet.create({
  rowValue: { maxWidth: '50%', fontSize: 13, color: colors.muted500 },
  safe: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { alignItems: 'center', paddingVertical: space(6), backgroundColor: colors.white },
  camera: { position: 'absolute', right: -2, bottom: -2, width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary700, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: colors.white },
  title: { marginTop: space(3), fontSize: 22, fontWeight: '700', color: colors.muted900 },
  subtitle: { marginTop: space(1), fontSize: 14, color: colors.muted500 },
  about: { marginTop: space(3), paddingHorizontal: space(8), fontSize: 14, color: colors.muted700, textAlign: 'center' },
  section: { marginTop: space(3), backgroundColor: colors.white },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: space(4) },
  sectionTitle: { paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(2), fontSize: 12, fontWeight: '700', color: colors.muted500, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(4), paddingHorizontal: space(4), paddingVertical: space(3.5) },
  rowText: { flex: 1, fontSize: 16, color: colors.muted900 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space(4), paddingVertical: space(3) },
  settingLabel: { fontSize: 15, color: colors.muted900 },
  settingValue: { fontSize: 15, color: colors.primary700, fontWeight: '600' },
  settingHint: { fontSize: 12, color: colors.muted500 },
  addButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: space(2) },
  addText: { color: colors.primary700, fontWeight: '600' },
  member: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(2.5) },
  memberName: { fontSize: 15, color: colors.muted900, fontWeight: '500' },
  adminBadge: { fontSize: 11, color: colors.primary800, backgroundColor: colors.primary100, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full, overflow: 'hidden' },
  modal: { flex: 1, backgroundColor: colors.white },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space(4) },
  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.muted900 },
});

export default ChatInfoScreen;
