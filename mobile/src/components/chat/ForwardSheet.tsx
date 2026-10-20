// src/components/ForwardSheet.tsx
// "Forward to…": choose up to 5 chats and send each a copy of the message.
import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, SendHorizontal, X } from 'lucide-react-native';
import { useChat } from '../../store/chat';
import { colors, radius, space } from '../../theme';
import Avatar from '../common/Avatar';

const MAX = 5;

const ForwardSheet: React.FC<{ visible: boolean; onClose: () => void; onSend: (ids: string[]) => void; title?: string }> = ({ visible, onClose, onSend, title = 'Forward to…' }) => {
  const conversations = useChat((s) => s.conversations);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...conversations]
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.lastMessageTime || 0).getTime() - new Date(a.lastMessageTime || 0).getTime());
  }, [conversations, query]);
  const close = () => { setPicked([]); setQuery(''); onClose(); };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX ? [...p, id] : p));

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={close} hitSlop={10} accessibilityLabel="Close"><X size={22} color={colors.muted600} /></Pressable>
        </View>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search chats" placeholderTextColor={colors.muted400} style={styles.search} />
        <FlatList
          data={list}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => {
            const on = picked.includes(item.id);
            return (
              <Pressable onPress={() => toggle(item.id)} style={styles.row} accessibilityState={{ selected: on }}>
                <Avatar uri={item.avatar} name={item.name} size={40} group={item.isGroup} />
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <View style={[styles.check, on && styles.checkOn]}>{on && <Check size={14} color={colors.white} />}</View>
              </Pressable>
            );
          }}
        />
        <View style={styles.footer}>
          <Text style={styles.picked} numberOfLines={1}>
            {picked.length ? conversations.filter((c) => picked.includes(c.id)).map((c) => c.name).join(', ') : `Choose up to ${MAX} chats`}
          </Text>
          <Pressable disabled={!picked.length} onPress={() => { onSend(picked); close(); }}
            style={[styles.send, !picked.length && { backgroundColor: colors.muted300 }]} accessibilityLabel="Send">
            <SendHorizontal size={20} color={colors.white} />
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: space(4) },
  title: { fontSize: 18, fontWeight: '700', color: colors.muted900 },
  search: { marginHorizontal: space(4), marginBottom: space(2), height: 44, paddingHorizontal: space(3), borderRadius: radius.md, backgroundColor: colors.muted100, fontSize: 15, color: colors.muted900 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(2.5) },
  name: { flex: 1, fontSize: 15, color: colors.muted900 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.muted300, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.primary700, borderColor: colors.primary700 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(4), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200 },
  picked: { flex: 1, fontSize: 14, color: colors.muted600 },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primary700, alignItems: 'center', justifyContent: 'center' },
});

export default ForwardSheet;
