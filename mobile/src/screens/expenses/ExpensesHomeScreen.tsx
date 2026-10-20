// src/screens/expenses/ExpensesHomeScreen.tsx
// Expenses tab: your money across every chat (Overall), then pick a chat to see its balances and expenses.
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ArrowRightLeft, ChevronDown, ChevronUp, PenLine, Wallet } from 'lucide-react-native';
import CategoryIcon from '../../components/expenses/CategoryIcon';
import { useDisplayCurrency } from '../../hooks/useDisplayCurrency';
import { useAuth } from '../../store/auth';
import { SafeAreaView } from 'react-native-safe-area-context';
import Avatar from '../../components/common/Avatar';
import Gradient, { CARD_GRADIENT } from '../../components/common/Gradient';
import { Empty } from '../../components/common/ui';
import { useChat } from '../../store/chat';
import { expenseService } from '../../api/expenses';
import type { ActivityItem, BalanceUser, ExpensesOverview } from '../../api/expenses';
import { formatMinor } from '../../utils/money';
import { colors, radius, space } from '../../theme';
import type { AppStackParams } from '../../navigation/types';

type Filter = 'all' | 'owe' | 'owed';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'owe', label: 'You owe' },
  { value: 'owed', label: 'Owed to you' },
];

/** Your balance in each chat: conversation id → currency → amount (positive: you're owed). */
function netsByChat(data: ExpensesOverview | null) {
  const nets: Record<string, Record<string, number>> = {};
  data?.people.forEach((p) => p.chats.forEach((ch) => {
    const chat = (nets[ch.conversation_id] ||= {});
    chat[p.currency] = (chat[p.currency] || 0) + ch.amount_minor;
  }));
  return nets;
}

const ExpensesHomeScreen: React.FC = () => {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const { conversations, loadConversations } = useChat();
  // Groups by default; a direct chat shows up once it has expenses (or with "Show all chats")
  const [withExpenses, setWithExpenses] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [overview, setOverview] = useState<ExpensesOverview | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [activity, setActivity] = useState<{ items: ActivityItem[]; users: Record<string, BalanceUser>; chats: Record<string, { name: string; is_group: boolean }> } | null>(null);
  const me = useAuth((s) => s.user?.id) || '';
  const { target, convert, approx } = useDisplayCurrency();
  useFocusEffect(useCallback(() => {
    loadConversations().catch(() => undefined);
    expenseService.overview().then(setOverview).catch(() => undefined);
    expenseService.recentActivity(30).then(setActivity).catch(() => undefined);
    expenseService.conversationsWithExpenses().then((ids) => setWithExpenses(new Set(ids))).catch(() => undefined);
  }, [loadConversations]));
  const nets = useMemo(() => netsByChat(overview), [overview]);
  const shown = conversations
    .filter((c) => showAll || c.isGroup || withExpenses.has(c.id))
    .sort((a, b) => new Date(b.lastMessageTime || 0).getTime() - new Date(a.lastMessageTime || 0).getTime());
  const hidden = conversations.length - shown.length;
  const list = shown.filter((c) => {
    const values = Object.values(nets[c.id] || {});
    if (filter === 'owe') return values.some((v) => v < 0);
    if (filter === 'owed') return values.some((v) => v > 0);
    return true;
  });
  const [main, ...others] = overview?.currencies || [];
  // Everything together in the display currency, when one is set and amounts are in others
  const together = target && overview?.currencies.some((c) => c.currency !== target)
    ? overview.currencies.reduce<number | null>((sum, c) => {
      const v = convert(c.net_minor, c.currency);
      return sum === null || v === null ? null : sum + v;
    }, 0)
    : null;
  const who = (id: string) => (id === me ? 'You' : activity?.users[id]?.name || activity?.users[id]?.username || 'Someone');
  let lastDay = '';
  const dayOf = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'TODAY';
    if (d.toDateString() === new Date(today.getTime() - 86400e3).toDateString()) return 'YESTERDAY';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <FlatList
        data={list}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ paddingBottom: space(6) }}
        ListHeaderComponent={
          <View>
            <Text style={styles.eyebrow}>SHARED MONEY</Text>
            <Text style={styles.title}>Expenses</Text>
            {overview && (
              <View style={styles.overall} accessibilityLabel="Overall">
                <Gradient from={CARD_GRADIENT.from} to={CARD_GRADIENT.to} />
                <Text style={styles.overallLabel}>OVERALL</Text>
                {!main ? (
                  <Text style={styles.overallSettled}>You're all settled up</Text>
                ) : (
                  <>
                    <Text style={styles.overallSub}>{main.net_minor > 0 ? 'You are owed' : main.net_minor < 0 ? 'You owe' : 'Settled'}</Text>
                    <Text style={[styles.overallNet, main.net_minor < 0 && { color: '#ffc9d1' }]}>{formatMinor(Math.abs(main.net_minor), main.currency)}</Text>
                    <Text style={styles.overallSub}>
                      Owed to you {formatMinor(main.owed_minor, main.currency)} · you owe {formatMinor(main.owe_minor, main.currency)}
                    </Text>
                    {together !== null && target && (
                      <Text style={styles.together}>≈ {together < 0 ? '−' : '+'}{formatMinor(Math.abs(together), target)} overall in {target}</Text>
                    )}
                    {others.length > 0 && (
                      <View style={styles.otherCurrencies}>
                        {others.map((c) => (
                          <Text key={c.currency} style={styles.otherCurrency}>
                            {c.net_minor >= 0 ? '+' : '−'}{formatMinor(Math.abs(c.net_minor), c.currency)}
                          </Text>
                        ))}
                      </View>
                    )}
                  </>
                )}
              </View>
            )}

            {!!overview?.people.length && (
              <View style={styles.people}>
                <Pressable onPress={() => setShowPeople((v) => !v)} style={styles.peopleToggle} accessibilityState={{ expanded: showPeople }}>
                  <Text style={styles.peopleToggleText}>By person ({overview.people.length})</Text>
                  {showPeople ? <ChevronUp size={18} color={colors.primary700} /> : <ChevronDown size={18} color={colors.primary700} />}
                </Pressable>
                {showPeople && overview.people.map((p) => {
                  const key = `${p.user_id}-${p.currency}`;
                  const u = overview.users[p.user_id];
                  const who = u?.name || u?.username || 'Someone';
                  return (
                    <View key={key}>
                      <Pressable onPress={() => setOpenPerson(openPerson === key ? null : key)} style={styles.person} accessibilityState={{ expanded: openPerson === key }}>
                        <Avatar uri={u?.avatar} name={who} size={32} />
                        <Text style={styles.personName} numberOfLines={1}>{who}</Text>
                        <Text style={[styles.personAmount, { color: p.net_minor > 0 ? colors.success700 : colors.danger500 }]}>
                          {p.net_minor > 0 ? 'owes you ' : 'you owe '}{formatMinor(Math.abs(p.net_minor), p.currency)}
                        </Text>
                      </Pressable>
                      {openPerson === key && p.chats.map((ch) => (
                        <Pressable key={ch.conversation_id} onPress={() => navigation.navigate('ChatExpenses', { conversationId: ch.conversation_id })} style={styles.chatLine}>
                          <Text style={styles.chatLineText} numberOfLines={1}>{ch.is_group ? ch.title || conversations.find((c) => c.id === ch.conversation_id)?.name || 'Group' : 'Direct chat'}</Text>
                          <Text style={styles.chatLineText}>{ch.amount_minor > 0 ? '+' : '−'}{formatMinor(Math.abs(ch.amount_minor), p.currency)}</Text>
                        </Pressable>
                      ))}
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.filters}>
              {FILTERS.map((f) => (
                <Pressable key={f.value} onPress={() => setFilter(f.value)} style={[styles.chip, filter === f.value && styles.chipOn]} accessibilityState={{ selected: filter === f.value }}>
                  <Text style={[styles.chipText, filter === f.value && styles.chipTextOn]}>{f.label}</Text>
                </Pressable>
              ))}
            </View>
            {list.length > 0 && <Text style={styles.section}>PEOPLE & GROUPS</Text>}
          </View>
        }
        ListEmptyComponent={
          shown.length
            ? <Text style={styles.nothing}>Nothing matches.</Text>
            : <Empty icon={Wallet} title="No groups yet" text="Create a group to share expenses" />
        }
        ListFooterComponent={
          <View>
            {(hidden > 0 || showAll) && (
              <Pressable onPress={() => setShowAll((v) => !v)} style={styles.more} hitSlop={8}>
                <Text style={styles.moreText}>{showAll ? 'Show groups only' : `Show all chats (${hidden} direct)`}</Text>
              </Pressable>
            )}
            {!!activity?.items.length && (
              <View style={styles.activity} accessibilityLabel="Recent activity">
                <Text style={styles.activityTitle}>Recent activity</Text>
                <Text style={styles.kind}>Expenses and payments from all your chats</Text>
                {activity.items.map((it) => {
                  const day = dayOf(it.at);
                  const header = day !== lastDay ? (lastDay = day) : null;
                  const chat = activity.chats[it.conversation_id]?.name || 'Chat';
                  if (it.kind === 'settlement') {
                    return (
                      <View key={`s-${it.id}`}>
                        {header && <Text style={styles.day}>{header}</Text>}
                        <Pressable onPress={() => navigation.navigate('ChatExpenses', { conversationId: it.conversation_id })} style={styles.actRow}>
                          <View style={styles.payIcon}><ArrowRightLeft size={16} color={colors.success700} /></View>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.actTitle} numberOfLines={1}>{who(it.from_user)} paid {it.to_user === me ? 'you' : who(it.to_user)}</Text>
                            <Text style={styles.kind} numberOfLines={1}>Payment · {chat}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={styles.actAmount}>{formatMinor(it.amount_minor, it.currency)}</Text>
                            {!!approx(it.amount_minor, it.currency) && <Text style={styles.netMore}>{approx(it.amount_minor, it.currency)}</Text>}
                          </View>
                        </Pressable>
                      </View>
                    );
                  }
                  const net = (it.payers.find((p) => p.user_id === me)?.amount_minor || 0) - (it.shares.find((s) => s.user_id === me)?.amount_minor || 0);
                  return (
                    <View key={`e-${it.id}`}>
                      {header && <Text style={styles.day}>{header}</Text>}
                      <Pressable onPress={() => navigation.navigate('ExpenseDetail', { expenseId: it.id })} style={styles.actRow}>
                        <CategoryIcon category={it.category} size={34} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.actTitle} numberOfLines={1}>{it.description}</Text>
                          <Text style={styles.kind} numberOfLines={1}>
                            {it.payers.length > 1 ? `${it.payers.length} people` : who(it.payers[0]?.user_id || '')} paid {formatMinor(it.total_minor, it.currency)} · {chat}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={[styles.actAmount, { color: net > 0 ? colors.success700 : net < 0 ? colors.danger500 : colors.muted400 }]}>
                            {net === 0 ? '—' : `${net > 0 ? '+' : '−'}${formatMinor(Math.abs(net), it.currency)}`}
                          </Text>
                          {net !== 0 && !!approx(Math.abs(net), it.currency) && <Text style={styles.netMore}>{approx(Math.abs(net), it.currency)}</Text>}
                        </View>
                        {it.can_edit && !it.locked && (
                          <Pressable onPress={() => navigation.navigate('AddExpense', { conversationId: it.conversation_id, expenseId: it.id })} hitSlop={8}
                            style={{ padding: space(1) }} accessibilityLabel={`Edit ${it.description}`}>
                            <PenLine size={16} color={colors.muted500} />
                          </Pressable>
                        )}
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => {
          const entries = Object.entries(nets[item.id] || {}).filter(([, v]) => v !== 0);
          return (
            <Pressable onPress={() => navigation.navigate('ChatExpenses', { conversationId: item.id })} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.primary50 }]}>
              <Avatar uri={item.avatar} name={item.name} size={46} group={item.isGroup} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.kind}>{item.isGroup ? `${item.members?.length || 0} members` : 'Direct expenses'}</Text>
              </View>
              {entries.length ? (
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.net, { color: entries[0][1] > 0 ? colors.success700 : colors.danger500 }]}>
                    {entries[0][1] > 0 ? '+' : '−'}{formatMinor(Math.abs(entries[0][1]), entries[0][0])}
                  </Text>
                  {!!approx(Math.abs(entries[0][1]), entries[0][0]) && <Text style={styles.netMore}>{approx(Math.abs(entries[0][1]), entries[0][0])}</Text>}
                  {entries.length > 1 && <Text style={styles.netMore}>+{entries.length - 1} more</Text>}
                </View>
              ) : (
                <Text style={styles.settled}>Settled</Text>
              )}
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },
  eyebrow: { paddingHorizontal: space(4), paddingTop: space(4), fontSize: 11, fontWeight: '700', letterSpacing: 1.3, color: colors.primary500 },
  title: { paddingHorizontal: space(4), marginTop: 2, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, color: colors.muted900 },
  overall: { margin: space(4), padding: space(5), borderRadius: 18, overflow: 'hidden', backgroundColor: CARD_GRADIENT.middle },
  overallLabel: { fontSize: 11, letterSpacing: 1.3, color: colors.primary100 },
  overallSettled: { marginTop: space(2), fontSize: 20, fontWeight: '700', color: colors.white },
  overallSub: { marginTop: space(1), fontSize: 12, color: colors.primary100 },
  overallNet: { fontSize: 32, fontWeight: '800', letterSpacing: -0.8, color: colors.white },
  otherCurrencies: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(3) },
  otherCurrency: { paddingHorizontal: space(2.5), paddingVertical: space(1), borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', color: colors.white, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
  people: { marginHorizontal: space(4), marginTop: -space(1) },
  peopleToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space(2) },
  peopleToggleText: { fontSize: 14, fontWeight: '700', color: colors.primary700 },
  person: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingVertical: space(2) },
  personName: { flex: 1, fontSize: 14, color: colors.muted900 },
  personAmount: { fontSize: 14, fontWeight: '700' },
  chatLine: { flexDirection: 'row', justifyContent: 'space-between', gap: space(3), paddingLeft: space(11), paddingBottom: space(1.5) },
  chatLineText: { fontSize: 12, color: colors.muted600 },
  filters: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(4) },
  chip: { paddingHorizontal: space(3.5), paddingVertical: space(1.5), borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  chipOn: { backgroundColor: colors.primary100, borderColor: colors.primary100 },
  chipText: { fontSize: 13, color: colors.muted500, fontWeight: '600' },
  chipTextOn: { color: colors.primary700 },
  section: { paddingHorizontal: space(5), paddingBottom: space(1), fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.muted500 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginHorizontal: space(2), paddingHorizontal: space(2.5), paddingVertical: space(3), borderRadius: 14 },
  name: { fontSize: 16, fontWeight: '700', color: colors.muted900 },
  kind: { marginTop: 2, fontSize: 13, color: colors.muted500 },
  net: { fontSize: 14, fontWeight: '700' },
  netMore: { fontSize: 10, fontWeight: '600', color: colors.muted400 },
  settled: { fontSize: 12, fontWeight: '600', color: colors.muted400 },
  nothing: { padding: space(6), textAlign: 'center', color: colors.muted500 },
  more: { padding: space(4), alignItems: 'center' },
  together: { marginTop: space(2), fontSize: 14, fontWeight: '700', color: colors.white },
  activity: { margin: space(4), marginTop: space(2), padding: space(4), borderRadius: 17, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  activityTitle: { fontSize: 16, fontWeight: '700', color: colors.muted900 },
  day: { marginTop: space(4), marginBottom: space(1), fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.muted400 },
  actRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(2.5) },
  actTitle: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  actAmount: { fontSize: 14, fontWeight: '700', color: colors.muted900 },
  payIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: colors.success50, alignItems: 'center', justifyContent: 'center' },
  moreText: { fontSize: 14, fontWeight: '600', color: colors.primary700 },
});

export default ExpensesHomeScreen;
