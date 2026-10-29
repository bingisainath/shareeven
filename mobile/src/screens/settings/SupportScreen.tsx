// src/screens/settings/SupportScreen.tsx
// Settings → Contact support: send the ShareEven team a request, and see your earlier ones and the
// team's replies (which also arrive under Notices, with a push).
import React, { useCallback, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LifeBuoy, Send } from 'lucide-react-native';
import { errorMessage } from '../../api/client';
import { SUPPORT_CATEGORIES, supportApi } from '../../api/support';
import type { SupportCategory, SupportTicket } from '../../api/support';
import { Banner, Button, TextField } from '../../components/common/ui';
import { showAlert } from '../../components/common/Dialog';
import { colors, radius, space } from '../../theme';

const when = (iso: string | null) =>
  (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find((x) => x.value === c)?.label || c;

const SupportScreen: React.FC = () => {
  const [category, setCategory] = useState<SupportCategory>('bug');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => supportApi.mine().then(setTickets).catch(() => undefined), []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const ready = subject.trim().length >= 3 && message.trim().length >= 10;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await supportApi.send({ category, subject: subject.trim(), message: message.trim(), app_info: `${Platform.OS} ${Platform.Version}` });
      setSubject('');
      setMessage('');
      load();
      showAlert('Sent', "Thanks. We'll reply here and under Notices.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <View style={styles.head}>
        <View style={styles.headIcon}><LifeBuoy size={20} color={colors.primary700} /></View>
        <Text style={styles.lead}>
          Tell us what went wrong or what you'd like. We read every request. Don't include passwords or your recovery key.
          To report a person or a message, use Report in the chat instead.
        </Text>
      </View>

      <Text style={styles.label}>What's it about?</Text>
      {SUPPORT_CATEGORIES.map((c) => {
        const on = category === c.value;
        return (
          <Pressable key={c.value} onPress={() => setCategory(c.value)} style={[styles.option, on && styles.optionOn]}
            accessibilityRole="radio" accessibilityState={{ checked: on }}>
            <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
            <Text style={styles.optionText}>{c.label}</Text>
          </Pressable>
        );
      })}

      <View style={{ height: space(3) }} />
      <TextField label="Subject" value={subject} onChangeText={setSubject} maxLength={120} placeholder="e.g. Receipt scan stuck on Reading" />
      <TextField label="Details" value={message} onChangeText={setMessage} multiline maxLength={3000}
        placeholder="What did you do, what happened, and what did you expect?" style={{ minHeight: 110, textAlignVertical: 'top' }}
        hint={`${message.length}/3000`} />

      {error && <Banner text={error} />}
      <Button title="Send" icon={Send} onPress={submit} loading={busy} disabled={!ready} />

      {tickets.length > 0 && (
        <>
          <Text style={[styles.label, { marginTop: space(6) }]}>YOUR REQUESTS</Text>
          {tickets.map((t) => (
            <View key={t.id} style={styles.ticket}>
              <View style={styles.ticketHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ticketSubject}>{t.subject}</Text>
                  <Text style={styles.ticketMeta}>{categoryLabel(t.category)} · {when(t.created_at)}</Text>
                </View>
                <Text style={[styles.pill, t.reply ? styles.pillDone : t.status === 'closed' ? styles.pillClosed : styles.pillWaiting]}>
                  {t.reply ? 'Answered' : t.status === 'closed' ? 'Closed' : 'Waiting'}
                </Text>
              </View>
              <Text style={styles.ticketText}>{t.message}</Text>
              {!!t.reply && (
                <View style={styles.reply}>
                  <Text style={styles.replyFrom}>ShareEven support · {when(t.replied_at)}</Text>
                  <Text style={styles.ticketText} selectable>{t.reply}</Text>
                </View>
              )}
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  content: { padding: space(5), paddingBottom: space(10), backgroundColor: colors.background, flexGrow: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginBottom: space(4) },
  headIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary50 },
  lead: { flex: 1, fontSize: 13, color: colors.muted500 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted500, marginBottom: space(2) },
  option: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(3), paddingVertical: space(3),
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white, marginBottom: space(2) },
  optionOn: { borderColor: colors.primary600, backgroundColor: colors.primary50 },
  optionText: { flex: 1, fontSize: 15, color: colors.muted900 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.muted400, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.primary700 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary700 },
  ticket: { padding: space(4), borderRadius: radius.lg, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white, marginBottom: space(3), gap: space(2) },
  ticketHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2) },
  ticketSubject: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  ticketMeta: { fontSize: 12, color: colors.muted500, marginTop: 2 },
  ticketText: { fontSize: 14, color: colors.muted700, lineHeight: 20 },
  pill: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  pillDone: { backgroundColor: colors.success50, color: colors.success700 },
  pillClosed: { backgroundColor: colors.muted100, color: colors.muted600 },
  pillWaiting: { backgroundColor: colors.warning50, color: colors.warning700 },
  reply: { padding: space(3), borderRadius: radius.md, backgroundColor: colors.primary50, gap: 2 },
  replyFrom: { fontSize: 12, fontWeight: '700', color: colors.primary700 },
});

export default SupportScreen;
