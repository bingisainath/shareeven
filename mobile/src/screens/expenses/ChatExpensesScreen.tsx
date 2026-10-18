// src/screens/expenses/ChatExpensesScreen.tsx
// One chat's money, in four tabs (same as web/src/components/expenses/ChatExpenses.tsx):
//   You       only your own numbers: what you paid, your share, who you owe and who owes you
//   Balances  every member: paid, share, balance, and the payments that settle everyone up
//   Summary   total spent, by category, by member and by month
//   History   expenses and payments together, filtered by date, category, member or type
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ArrowRightLeft, BellRing, CheckCircle2, ChevronDown, Download, Lock, PenLine, Plus, ScrollText, Wallet } from 'lucide-react-native';
import { useDisplayCurrency } from '../../hooks/useDisplayCurrency';
import { payOptions } from '../../utils/pay';
import type { PayHandles } from '../../utils/pay';
import Avatar from '../../components/common/Avatar';
import { Button } from '../../components/common/ui';
import { expenseService } from '../../api/expenses';
import type { ActivityFilters, ActivityItem, Balances, CurrencySummary, ExpenseSummary } from '../../api/expenses';
import { errorMessage } from '../../api/client';
import { useAuth } from '../../store/auth';
import { decimalsFor, formatMinor, parseMajor, toMajorString } from '../../utils/money';
import { colors, radius, space } from '../../theme';
import type { AppStackParams } from '../../navigation/types';
import CategoryIcon from '../../components/expenses/CategoryIcon';
import Svg, { Circle } from 'react-native-svg';
import { useExpenseChanges } from '../../hooks/useMembers';
import { showAlert } from '../../components/common/Dialog';
import Gradient, { CARD_GRADIENT } from '../../components/common/Gradient';
import { useChat } from '../../store/chat';

type Tab = 'you' | 'balances' | 'summary' | 'history';
type Settle = { from: string; to: string; currency: string; amount: string; editing?: string; note?: string | null };
type Users = ExpenseSummary['users'];

const TABS: { value: Tab; label: string }[] = [
  { value: 'you', label: 'You' }, { value: 'balances', label: 'Balances' }, { value: 'summary', label: 'Summary' }, { value: 'history', label: 'History' },
];
const CATEGORIES = ['groceries', 'food', 'drinks', 'transport', 'travel', 'rent', 'utilities', 'household', 'entertainment', 'shopping', 'health', 'gifts', 'other'];
const label = (category: string) => category.charAt(0).toUpperCase() + category.slice(1);

type DateRange = 'all' | 'month' | '30d' | '90d' | 'year';
const RANGES: { value: DateRange; label: string }[] = [
  { value: 'all', label: 'All time' }, { value: 'month', label: 'This month' }, { value: '30d', label: '30 days' }, { value: '90d', label: '3 months' }, { value: 'year', label: 'This year' },
];
function rangeOf(range: DateRange): Pick<ActivityFilters, 'date_from'> {
  const now = new Date();
  const from = { all: null, month: new Date(now.getFullYear(), now.getMonth(), 1), '30d': new Date(now.getTime() - 30 * 86400e3), '90d': new Date(now.getTime() - 90 * 86400e3), year: new Date(now.getFullYear(), 0, 1) }[range];
  return from ? { date_from: from.toISOString() } : {};
}

const netColor = (net: number) => (net > 0 ? colors.success700 : net < 0 ? colors.danger600 : colors.muted500);
const netText = (net: number, currency: string, you = false) =>
  net > 0 ? `${you ? 'You get back' : 'Gets back'} ${formatMinor(net, currency)}` : net < 0 ? `${you ? 'You owe' : 'Owes'} ${formatMinor(-net, currency)}` : 'Settled';

const ChatExpensesScreen: React.FC<NativeStackScreenProps<AppStackParams, 'ChatExpenses'>> = ({ route, navigation }) => {
  const { conversationId } = route.params;
  const me = useAuth((s) => s.user)!;
  const [tab, setTab] = useState<Tab>('you');
  const [balances, setBalances] = useState<Balances | null>(null);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [settle, setSettle] = useState<Settle | null>(null);
  const [choosing, setChoosing] = useState(false); // "Settle up" with several people: pick one first
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([expenseService.balances(conversationId), expenseService.summary(conversationId)]);
      setBalances(b);
      setSummary(s);
      setVersion((v) => v + 1);
    } catch (e) {
      showAlert("Couldn't load expenses", errorMessage(e));
    }
  }, [conversationId]);

  useEffect(() => { load(); }, [load]);
  useExpenseChanges(conversationId, load);

  const hasExpenses = !!summary?.currencies.length;
  const download = useCallback(async () => {
    setDownloading(true);
    try {
      const file = await expenseService.saveExcel(conversationId);
      if (Platform.OS === 'android') showAlert('Saved to Downloads', file);
    } catch (e) {
      showAlert("Couldn't download", errorMessage(e));
    } finally {
      setDownloading(false);
    }
  }, [conversationId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerButtons}>
          {hasExpenses && (downloading ? <ActivityIndicator color={colors.primary700} /> : (
            <Pressable onPress={download} hitSlop={8} accessibilityLabel="Download as Excel"><Download size={22} color={colors.primary700} /></Pressable>
          ))}
          <Pressable onPress={() => navigation.navigate('AddExpense', { conversationId })} hitSlop={8} accessibilityLabel="Add expense">
            <Plus size={24} color={colors.primary700} />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, conversationId, hasExpenses, downloading, download]);

  const chat = useChat((st) => st.conversations.find((c) => c.id === conversationId));
  useLayoutEffect(() => {
    if (chat?.name) navigation.setOptions({ title: chat.name });
  }, [navigation, chat?.name]);

  const users: Users = summary?.users || balances?.users || {};
  const name = (id: string) => (id === me.id ? 'You' : users[id]?.name || users[id]?.username || 'Someone');

  const record = async () => {
    if (!settle) return;
    const minor = parseMajor(settle.amount, settle.currency);
    if (!minor || minor <= 0) { showAlert('Enter the amount paid'); return; }
    // More than is owed flips the balance the other way: make sure that's meant
    const owed = balances?.currencies.find((c) => c.currency === settle.currency)?.debts
      .find((d) => d.from_user === settle.from && d.to_user === settle.to)?.amount_minor || 0;
    if (!settle.editing && minor > owed) {
      const sure = await new Promise<boolean>((resolve) => showAlert(
        'More than is owed',
        owed
          ? `${settle.from === me.id ? 'You owe' : `${name(settle.from)} owes`} ${formatMinor(owed, settle.currency)}. Recording ${formatMinor(minor, settle.currency)} means ${settle.to === me.id ? 'you' : name(settle.to)} will owe the difference back.`
          : `${settle.from === me.id ? 'You don’t' : `${name(settle.from)} doesn’t`} owe ${settle.to === me.id ? 'you' : name(settle.to)} anything in ${settle.currency}. Record it anyway?`,
        [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) }, { text: 'Record anyway', onPress: () => resolve(true) }],
        { cancelable: false },
      ));
      if (!sure) return;
    }
    setSaving(true);
    try {
      // Send "12.30" whatever the keyboard typed ("12,30")
      const amount = toMajorString(minor, settle.currency);
      if (settle.editing) await expenseService.updateSettlement(settle.editing, { amount, note: settle.note });
      else await expenseService.settle(conversationId, { from_user: settle.from, to_user: settle.to, currency: settle.currency, amount });
      setSettle(null);
      load();
    } catch (e) {
      showAlert("Couldn't record the payment", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!balances || !summary) return <View style={styles.center}><ActivityIndicator color={colors.primary700} /></View>;
  const props = { summary, balances, me: me.id, name, users, onSettle: setSettle, conversationId };

  // "Settle up": straight to the payment when there's one; otherwise choose who with
  const myDebts = balances.currencies.flatMap((c) =>
    c.debts.filter((d) => d.from_user === me.id || d.to_user === me.id).map((d) => ({ ...d, currency: c.currency })));
  const settleUp = () => {
    if (myDebts.length === 1) {
      const d = myDebts[0];
      setSettle({ from: d.from_user, to: d.to_user, currency: d.currency, amount: toMajorString(d.amount_minor, d.currency) });
    } else {
      setChoosing(true);
    }
  };

  return (
    <View style={styles.container}>
      {hasExpenses && (
        <PositionCard summary={summary} me={me.id} isGroup={!!chat?.isGroup}
          onAdd={() => navigation.navigate('AddExpense', { conversationId })} onSettle={myDebts.length ? settleUp : undefined} />
      )}
      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable key={t.value} onPress={() => setTab(t.value)} style={[styles.tab, tab === t.value && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === t.value }}>
            <Text style={[styles.tabText, tab === t.value && styles.tabTextOn]}>{t.label}</Text>
            {tab === t.value && <View style={styles.tabLine} />}
          </Pressable>
        ))}
      </View>
      {tab === 'history' ? (
        <HistoryTab conversationId={conversationId} me={me.id} name={name} users={users} version={version}
          onOpen={(id) => navigation.navigate('ExpenseDetail', { expenseId: id })} onChanged={load}
          onEdit={(id) => navigation.navigate('AddExpense', { conversationId, expenseId: id })}
          onEditPayment={(it) => setSettle({ from: it.from_user, to: it.to_user, currency: it.currency, amount: toMajorString(it.amount_minor, it.currency), editing: it.id, note: it.note })} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
          {!hasExpenses ? (
            <Text style={styles.empty}>No expenses yet. Tap + to add one, or scan a receipt from the chat.</Text>
          ) : tab === 'you' ? <YouTab {...props} /> : tab === 'balances' ? <BalancesTab {...props} /> : <SummaryTab summary={summary} name={name} users={users} />}
        </ScrollView>
      )}

      <Modal visible={choosing} transparent animationType="fade" onRequestClose={() => setChoosing(false)}>
        <Pressable style={styles.backdrop} onPress={() => setChoosing(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Settle up with</Text>
            <ScrollView style={styles.choices}>
              {myDebts.map((d) => {
                const iOwe = d.from_user === me.id;
                const other = iOwe ? d.to_user : d.from_user;
                return (
                  <Pressable
                    key={`${d.currency}-${d.from_user}-${d.to_user}`}
                    onPress={() => {
                      setChoosing(false);
                      setSettle({ from: d.from_user, to: d.to_user, currency: d.currency, amount: toMajorString(d.amount_minor, d.currency) });
                    }}
                    style={({ pressed }) => [styles.row, styles.choice, pressed && { backgroundColor: colors.muted100 }]}
                    accessibilityRole="button"
                  >
                    <Avatar uri={users[other]?.avatar} name={users[other]?.name || users[other]?.username || 'Someone'} size={32} />
                    <Text style={styles.rowText} numberOfLines={2}>{iOwe ? `You owe ${name(other)}` : `${name(other)} owes you`}</Text>
                    <Text style={[styles.rowAmount, { color: iOwe ? colors.danger600 : colors.success700 }]}>{formatMinor(d.amount_minor, d.currency)}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!settle} transparent animationType="fade" onRequestClose={() => setSettle(null)}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={styles.backdrop} onPress={() => setSettle(null)}>
          {settle && (
            <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.sheetTitle}>{settle.editing ? 'Edit payment' : 'Settle up'}</Text>
              <Text style={styles.sheetText}>
                {settle.editing
                  ? `Change how much ${settle.from === me.id ? 'you' : name(settle.from)} paid ${settle.to === me.id ? 'you' : name(settle.to)}. Everyone in the chat is told.`
                  : `Record that ${settle.from === me.id ? 'you' : name(settle.from)} paid ${settle.to === me.id ? 'you' : name(settle.to)}. ShareEven doesn't move money: pay however you like, then record it here.`}
              </Text>
              <TextInput value={settle.amount} onChangeText={(amount) => setSettle({ ...settle, amount })} keyboardType="decimal-pad" style={styles.amount} accessibilityLabel="Amount paid" />
              <Button title={settle.editing ? 'Save changes' : 'Record payment'} onPress={record} loading={saving} />
            </Pressable>
          )}
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
};

/** The purple card on top: where you stand in this chat, with the two things you'll do next. */
const PositionCard: React.FC<{ summary: ExpenseSummary; me: string; isGroup: boolean; onAdd: () => void; onSettle?: () => void }> = ({
  summary, isGroup, onAdd, onSettle,
}) => {
  const { approx } = useDisplayCurrency();
  // Lead with the currency where you're most out of balance
  const main = [...summary.currencies].sort((a, b) => Math.abs(b.me.net_minor) - Math.abs(a.me.net_minor))[0];
  const net = main.me.net_minor;
  const stats = [
    { label: `${main.currency} balance`, value: `${net > 0 ? '+' : net < 0 ? '−' : ''}${formatMinor(Math.abs(net), main.currency)}` },
    { label: 'You paid', value: formatMinor(main.me.paid_minor, main.currency) },
    { label: 'Your share', value: formatMinor(main.me.share_minor, main.currency) },
  ];
  return (
    <View style={styles.position} accessibilityLabel="Your position">
      <Gradient from={CARD_GRADIENT.from} to={CARD_GRADIENT.to} />
      <Text style={styles.positionLabel}>YOUR POSITION</Text>
      <Text style={styles.positionTitle}>
        {net === 0 ? `You're settled up${isGroup ? ' in this group' : ''}` : (
          <>
            {net > 0 ? 'You are owed ' : 'You owe '}
            <Text style={[styles.positionAmount, net < 0 && { color: '#ffc9d1' }]}>{formatMinor(Math.abs(net), main.currency)}</Text>
          </>
        )}
      </Text>
      {net !== 0 && !!approx(Math.abs(net), main.currency) && <Text style={styles.positionApprox}>{approx(Math.abs(net), main.currency)}</Text>}
      <View style={styles.posStats}>
        {stats.map((st) => (
          <View key={st.label} style={styles.posStat}>
            <Text style={styles.posStatLabel} numberOfLines={1}>{st.label}</Text>
            <Text style={styles.posStatValue} numberOfLines={1}>{st.value}</Text>
          </View>
        ))}
      </View>
      <View style={styles.positionActions}>
        <Pressable onPress={onAdd} style={({ pressed }) => [styles.positionButton, styles.positionAdd, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Plus size={17} color={colors.white} />
          <Text style={styles.positionButtonText}>Add expense</Text>
        </Pressable>
        {onSettle && (
          <Pressable onPress={onSettle} style={({ pressed }) => [styles.positionButton, styles.positionSettle, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            <Text style={styles.positionButtonText}>Settle up</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
};

interface TabProps { summary: ExpenseSummary; balances: Balances; me: string; name: (id: string) => string; users: Users; onSettle: (s: Settle) => void; conversationId: string }

/** "Pay": choose one of the payee's payment apps; it opens with the amount (copied first for Revolut). */
function pay(handles: PayHandles | undefined, minor: number, currency: string, payee: string) {
  const options = payOptions(handles, minor, currency, decimalsFor(currency), payee, 'ShareEven');
  const open = (o: (typeof options)[number]) => {
    if (o.copyAmount) Clipboard.setString(toMajorString(minor, currency));
    Linking.openURL(o.url).catch(() => showAlert(`Couldn't open ${o.label}`, 'Is the app installed?'));
  };
  if (options.length === 1) {
    open(options[0]);
    return;
  }
  showAlert(`Pay ${payee} ${formatMinor(minor, currency)}`, 'Then come back and tap Settle to record it.', [
    ...options.map((o) => ({ text: o.copyAmount ? `${o.label} (amount copied)` : o.label, onPress: () => open(o) })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

const RemindButton: React.FC<{ conversationId: string; userId: string; currency: string }> = ({ conversationId, userId, currency }) => {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const remind = async () => {
    setState('busy');
    try {
      await expenseService.remind(conversationId, userId, currency);
      setState('sent');
    } catch (e) {
      setState('idle');
      showAlert("Couldn't send the reminder", errorMessage(e));
    }
  };
  return (
    <Pressable onPress={remind} disabled={state !== 'idle'} style={[styles.outlineButton, state !== 'idle' && { opacity: 0.5 }]} accessibilityLabel="Remind them">
      <BellRing size={13} color={colors.muted700} />
      <Text style={styles.outlineText}>{state === 'sent' ? 'Reminded' : 'Remind'}</Text>
    </Pressable>
  );
};

const Stat: React.FC<{ title: string; minor: number; currency: string }> = ({ title, minor, currency }) => (
  <View style={styles.stat}><Text style={styles.statLabel}>{title}</Text><Text style={styles.statValue}>{formatMinor(minor, currency)}</Text></View>
);

// ---------------------------------------------------------------- You

const YouTab: React.FC<TabProps> = ({ summary, balances, me, name, users, onSettle, conversationId }) => (
  <>
    {summary.currencies.map((c) => {
      const debts = balances.currencies.find((b) => b.currency === c.currency)?.debts.filter((d) => d.from_user === me || d.to_user === me) || [];
      return (
        <View key={c.currency} style={styles.card}>
          <View style={styles.cardTop}>
            <Text style={styles.currency}>{c.currency}</Text>
            <Text style={[styles.net, { color: netColor(c.me.net_minor) }]}>{netText(c.me.net_minor, c.currency, true)}</Text>
          </View>
          <View style={styles.stats}>
            <Stat title="You paid" minor={c.me.paid_minor} currency={c.currency} />
            <Stat title="Your share" minor={c.me.share_minor} currency={c.currency} />
            <Stat title="You paid back" minor={c.me.sent_minor} currency={c.currency} />
            <Stat title="Paid back to you" minor={c.me.received_minor} currency={c.currency} />
          </View>
          {debts.length === 0 ? (
            <View style={styles.row}><CheckCircle2 size={16} color={colors.success700} /><Text style={styles.settledText}>Nothing to settle</Text></View>
          ) : debts.map((d) => {
            const other = d.from_user === me ? d.to_user : d.from_user;
            const iOwe = d.from_user === me;
            return (
              <View key={`${d.from_user}-${d.to_user}`} style={styles.debtBlock}>
              <View style={styles.row}>
                <Avatar uri={users[other]?.avatar} name={users[other]?.name || users[other]?.username || 'Someone'} size={28} />
                <Text style={styles.rowText} numberOfLines={2}>{iOwe ? `You owe ${name(other)}` : `${name(other)} owes you`}</Text>
                <Text style={[styles.rowAmount, { color: iOwe ? colors.danger600 : colors.success700 }]}>{formatMinor(d.amount_minor, c.currency)}</Text>
              </View>
              <View style={styles.actions}>
                {iOwe ? (
                  payOptions(users[other]?.pay, d.amount_minor, c.currency, decimalsFor(c.currency), name(other), '').length > 0 && (
                    <Pressable onPress={() => pay(users[other]?.pay, d.amount_minor, c.currency, users[other]?.name || users[other]?.username || 'them')} style={styles.payButton} accessibilityLabel="Pay">
                      <Wallet size={13} color={colors.white} /><Text style={styles.payText}>Pay</Text>
                    </Pressable>
                  )
                ) : <RemindButton conversationId={conversationId} userId={other} currency={c.currency} />}
                <Pressable onPress={() => onSettle({ from: d.from_user, to: d.to_user, currency: c.currency, amount: toMajorString(d.amount_minor, c.currency) })} style={styles.smallButton}>
                  <Text style={styles.smallButtonText}>{iOwe ? 'Settle' : 'Mark paid'}</Text>
                </Pressable>
              </View>
              </View>
            );
          })}
        </View>
      );
    })}
    <Text style={styles.note}>Only your own amounts are shown here. See Balances for everyone.</Text>
  </>
);

// ---------------------------------------------------------------- Balances

const BalancesTab: React.FC<TabProps> = ({ summary, balances, me, name, users, onSettle }) => (
  <>
    {summary.currencies.map((c) => {
      const debts = balances.currencies.find((b) => b.currency === c.currency)?.debts || [];
      return (
        <View key={c.currency} style={styles.card}>
          <Text style={styles.cardTitle}>{c.currency} · each member</Text>
          {c.members.map((m) => (
            <View key={m.user_id} style={styles.row}>
              <Avatar uri={users[m.user_id]?.avatar} name={users[m.user_id]?.name || users[m.user_id]?.username || 'Someone'} size={30} />
              <View style={styles.flex}>
                <Text style={[styles.memberName, m.user_id === me && styles.bold]} numberOfLines={1}>{name(m.user_id)}</Text>
                <Text style={styles.sub}>Paid {formatMinor(m.paid_minor, c.currency)} · share {formatMinor(m.share_minor, c.currency)}</Text>
              </View>
              <Text style={[styles.rowAmount, { color: netColor(m.net_minor) }]}>{netText(m.net_minor, c.currency)}</Text>
            </View>
          ))}
          <View style={[styles.row, { marginTop: space(2) }]}><ArrowRightLeft size={16} color={colors.muted500} /><Text style={styles.cardTitle}>To settle up</Text></View>
          {debts.length === 0 ? (
            <View style={styles.row}><CheckCircle2 size={16} color={colors.success700} /><Text style={styles.settledText}>Everyone is settled up</Text></View>
          ) : debts.map((d) => (
            <View key={`${d.from_user}-${d.to_user}`} style={styles.row}>
              <Text style={styles.rowText} numberOfLines={2}>{name(d.from_user)} {d.from_user === me ? 'pay' : 'pays'} {d.to_user === me ? 'you' : name(d.to_user)}</Text>
              <Text style={styles.rowAmount}>{formatMinor(d.amount_minor, c.currency)}</Text>
              <Pressable onPress={() => onSettle({ from: d.from_user, to: d.to_user, currency: c.currency, amount: toMajorString(d.amount_minor, c.currency) })} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>Record</Text>
              </Pressable>
            </View>
          ))}
        </View>
      );
    })}
    <Text style={styles.note}>{balances.simplified ? 'Payments are simplified to the fewest needed.' : 'Showing who owes whom directly.'} Change this in the chat's info.</Text>
  </>
);

// ---------------------------------------------------------------- Summary

const Bar: React.FC<{ part: number; whole: number }> = ({ part, whole }) => (
  <View style={styles.barTrack}><View style={[styles.barFill, { width: `${whole ? Math.max(2, (part / whole) * 100) : 0}%` }]} /></View>
);

// Category colours, in a fixed order (validated for colour-blind separation); the rest fold into "Other"
const SLICE_COLORS = ['#4a3aa7', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER_COLOR = '#94a3b8';
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** Donut of spending by category: thin ring with 2px gaps; the middle shows the total or the tapped slice. */
const Donut: React.FC<{ slices: { label: string; value: number; color: string }[]; active: number | null; onPick: (i: number | null) => void; center: React.ReactNode }> = ({
  slices, active, onPick, center,
}) => {
  const size = 168;
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const sum = slices.reduce((a, x) => a + x.value, 0) || 1;
  const gap = slices.length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <View style={{ width: size, height: size }} accessibilityLabel="Spending by category">
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f0f5" strokeWidth={stroke} />
        {slices.map((sl, i) => {
          const len = (sl.value / sum) * c;
          const dash = Math.max(len - gap, 0.5);
          const el = (
            <Circle key={sl.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={sl.color}
              strokeWidth={active === i ? stroke + 6 : stroke} strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
              opacity={active === null || active === i ? 1 : 0.35}
              rotation={-90} origin={`${size / 2}, ${size / 2}`} onPress={() => onPick(active === i ? null : i)} />
          );
          offset += len;
          return el;
        })}
      </Svg>
      <View style={styles.donutCenter} pointerEvents="none">{center}</View>
    </View>
  );
};

const SummaryTab: React.FC<{ summary: ExpenseSummary; name: (id: string) => string; users: Users }> = ({ summary, name, users }) => {
  const [active, setActive] = useState<{ currency: string; index: number } | null>(null);
  const { approx } = useDisplayCurrency();
  const thisMonth = new Date().toISOString().slice(0, 7);
  return (
    <>
      {summary.currencies.map((c: CurrencySummary) => {
        const cats = [...c.by_category].sort((a, b) => b.total_minor - a.total_minor);
        const rest = cats.slice(SLICE_COLORS.length);
        const slices = [
          ...cats.slice(0, SLICE_COLORS.length).map((cat, i) => ({ label: label(cat.category), value: cat.total_minor, color: SLICE_COLORS[i], count: cat.count })),
          ...(rest.length ? [{ label: 'Other', value: rest.reduce((a, x) => a + x.total_minor, 0), color: OTHER_COLOR, count: rest.reduce((a, x) => a + x.count, 0) }] : []),
        ];
        const picked = active?.currency === c.currency ? active.index : null;
        const months = [...c.by_month].reverse().slice(-6);
        const topMonth = Math.max(...months.map((m) => m.total_minor), 1);
        const spenders = c.members.filter((m) => m.paid_minor || m.share_minor);
        const topPaid = Math.max(...spenders.map((m) => Math.max(m.paid_minor, m.share_minor)), 1);
        const tiles = [
          { k: 'Expenses', v: String(c.count) },
          { k: 'Average', v: formatMinor(c.count ? Math.round(c.total_minor / c.count) : 0, c.currency) },
          { k: 'This month', v: formatMinor(c.by_month.find((m) => m.month === thisMonth)?.total_minor || 0, c.currency) },
          { k: 'Top category', v: cats[0] ? label(cats[0].category) : '—' },
        ];
        return (
          <View key={c.currency} style={{ gap: space(3) }}>
            <View style={styles.card}>
              <Text style={styles.kicker}>TOTAL SPENT · {c.currency}</Text>
              <Text style={styles.total}>{formatMinor(c.total_minor, c.currency)}</Text>
              {!!approx(c.total_minor, c.currency) && <Text style={styles.sub}>{approx(c.total_minor, c.currency)}</Text>}
              <View style={styles.tiles}>
                {tiles.map((t) => (
                  <View key={t.k} style={styles.tile}>
                    <Text style={styles.tileLabel}>{t.k}</Text>
                    <Text style={styles.tileValue} numberOfLines={1}>{t.v}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.blockTitleTop}>By category</Text>
              <View style={{ alignItems: 'center' }}>
                <Donut slices={slices} active={picked} onPick={(i) => setActive(i === null ? null : { currency: c.currency, index: i })}
                  center={<>
                    <Text style={styles.sub}>{picked !== null ? slices[picked].label : 'Total'}</Text>
                    <Text style={styles.donutValue}>{picked !== null ? `${pct(slices[picked].value, c.total_minor)}%` : formatMinor(c.total_minor, c.currency)}</Text>
                  </>} />
              </View>
              {slices.map((sl, i) => (
                <Pressable key={sl.label} onPress={() => setActive(picked === i ? null : { currency: c.currency, index: i })}
                  style={[styles.legendRow, picked === i && { backgroundColor: colors.muted50 }]}>
                  <View style={[styles.legendDot, { backgroundColor: sl.color }]} />
                  <Text style={[styles.memberName, styles.flex]} numberOfLines={1}>{sl.label} <Text style={styles.sub}>· {sl.count}</Text></Text>
                  <Text style={styles.rowAmount}>{formatMinor(sl.value, c.currency)}</Text>
                  <Text style={styles.legendPct}>{pct(sl.value, c.total_minor)}%</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.card}>
              <Text style={styles.blockTitleTop}>By month</Text>
              <View style={styles.monthChart} accessibilityLabel="Spending by month">
                {months.map((m, i) => {
                  const latest = i === months.length - 1;
                  return (
                    <View key={m.month} style={styles.monthCol}>
                      {latest && <Text style={styles.monthValue}>{formatMinor(m.total_minor, c.currency)}</Text>}
                      <View style={[styles.monthBar, { height: `${Math.max(4, (m.total_minor / topMonth) * 80)}%`, backgroundColor: latest ? colors.primary600 : colors.primary200 }]} />
                      <Text style={styles.monthLabel}>{new Date(`${m.month}-01T12:00:00`).toLocaleDateString([], { month: 'short' })}</Text>
                    </View>
                  );
                })}
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.spread}>
                <Text style={styles.blockTitleTop}>By member</Text>
                <Text style={styles.sub}>paid · share</Text>
              </View>
              {spenders.map((m) => (
                <View key={m.user_id} style={styles.row}>
                  <Avatar uri={users[m.user_id]?.avatar} name={users[m.user_id]?.name || users[m.user_id]?.username || 'Someone'} size={30} />
                  <View style={[styles.flex, { gap: 4 }]}>
                    <View style={styles.spread}>
                      <Text style={styles.memberName} numberOfLines={1}>{name(m.user_id)}</Text>
                      <Text style={styles.rowAmount}>{formatMinor(m.paid_minor, c.currency)} <Text style={styles.sub}>· {formatMinor(m.share_minor, c.currency)}</Text></Text>
                    </View>
                    <Bar part={m.paid_minor} whole={topPaid} />
                    <View style={styles.barTrack}><View style={[styles.barFill, { backgroundColor: colors.primary200, width: `${(m.share_minor / topPaid) * 100}%` }]} /></View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        );
      })}
    </>
  );
};

// ---------------------------------------------------------------- History

const Chip: React.FC<{ text: string; on?: boolean; onPress: () => void; menu?: boolean }> = ({ text, on, onPress, menu }) => (
  <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityState={{ selected: !!on }}>
    <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    {menu && <ChevronDown size={14} color={on ? colors.primary800 : colors.muted500} />}
  </Pressable>
);

const Picker: React.FC<{ title: string; options: { value: string; label: string }[]; onPick: (v: string) => void; onClose: () => void }> = ({ title, options, onPick, onClose }) => (
  <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
        <Text style={styles.sheetTitle}>{title}</Text>
        <ScrollView style={{ maxHeight: 420 }}>
          {options.map((o) => (
            <Pressable key={o.value} onPress={() => onPick(o.value)} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.muted50 }]}>
              <Text style={styles.optionText}>{o.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </Pressable>
    </Pressable>
  </Modal>
);

const HistoryTab: React.FC<{
  conversationId: string; me: string; name: (id: string) => string; users: Users; version: number;
  onOpen: (expenseId: string) => void; onChanged: () => void; onEdit: (expenseId: string) => void;
  onEditPayment: (payment: Extract<ActivityItem, { kind: 'settlement' }>) => void;
}> = ({ conversationId, me, name, users, version, onOpen, onChanged, onEdit, onEditPayment }) => {
  const { approx } = useDisplayCurrency();
  const [range, setRange] = useState<DateRange>('all');
  const [category, setCategory] = useState('');
  const [member, setMember] = useState('');
  const [kind, setKind] = useState<'' | 'expense' | 'settlement'>('');
  const [picking, setPicking] = useState<'category' | 'member' | null>(null);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const filters = useMemo<ActivityFilters>(() => ({ ...rangeOf(range), ...(category ? { category } : {}), ...(member ? { member } : {}), ...(kind ? { kind } : {}) }),
    [range, category, member, kind]);
  const load = useCallback(() => expenseService.activity(conversationId, filters).then((r) => setItems(r.items)).catch((e) => showAlert("Couldn't load the history", errorMessage(e))),
    [conversationId, filters]);
  useEffect(() => { load(); }, [load, version]);

  const removePayment = (id: string) => showAlert('Undo this payment?', 'Balances go back to how they were before it, and the chat is told.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Undo', style: 'destructive', onPress: () => { expenseService.removeSettlement(id).then(onChanged).catch((e) => showAlert("Couldn't undo it", errorMessage(e))); } },
  ]);
  const filtered = range !== 'all' || !!category || !!member || !!kind;

  return (
    <ScrollView contentContainerStyle={styles.historyContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {RANGES.map((r) => <Chip key={r.value} text={r.label} on={range === r.value} onPress={() => setRange(r.value)} />)}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, styles.chipsLast]}>
        <Chip text={category ? label(category) : 'Category'} on={!!category} menu onPress={() => setPicking('category')} />
        <Chip text={member ? name(member) : 'Member'} on={!!member} menu onPress={() => setPicking('member')} />
        <Chip text="Expenses" on={kind === 'expense'} onPress={() => setKind(kind === 'expense' ? '' : 'expense')} />
        <Chip text="Payments" on={kind === 'settlement'} onPress={() => setKind(kind === 'settlement' ? '' : 'settlement')} />
        {filtered && <Chip text="Clear" onPress={() => { setRange('all'); setCategory(''); setMember(''); setKind(''); }} />}
      </ScrollView>

      {!items ? <ActivityIndicator style={{ marginTop: space(8) }} color={colors.primary700} /> : items.length === 0 ? (
        <Text style={styles.empty}>{filtered ? 'Nothing matches these filters.' : 'No expenses or payments yet.'}</Text>
      ) : <View style={styles.historyList}>{items.map((it) => {
        const when = new Date(it.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
        if (it.kind === 'settlement') {
          return (
            <View key={`s-${it.id}`} style={styles.item}>
              <View style={styles.payIcon}><ArrowRightLeft size={16} color={colors.success700} /></View>
              <View style={styles.flex}>
                <Text style={styles.itemTitle} numberOfLines={1}>{name(it.from_user)} paid {it.to_user === me ? 'you' : name(it.to_user)}</Text>
                <Text style={styles.sub}>Payment · {when}{it.note ? ` · ${it.note}` : ''}</Text>
                {[it.created_by, it.from_user, it.to_user].includes(me) && (
                  <View style={styles.payActions}>
                    <Pressable onPress={() => onEditPayment(it)} hitSlop={6} accessibilityLabel="Edit payment"><Text style={styles.payEdit}>Edit</Text></Pressable>
                    <Pressable onPress={() => removePayment(it.id)} hitSlop={6} accessibilityLabel="Undo payment"><Text style={styles.payUndo}>Undo</Text></Pressable>
                  </View>
                )}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.rowAmount}>{formatMinor(it.amount_minor, it.currency)}</Text>
                {!!approx(it.amount_minor, it.currency) && <Text style={styles.approx}>{approx(it.amount_minor, it.currency)}</Text>}
              </View>
            </View>
          );
        }
        const net = (it.payers.find((p) => p.user_id === me)?.amount_minor || 0) - (it.shares.find((s) => s.user_id === me)?.amount_minor || 0);
        const payer = it.payers.length > 1 ? `${it.payers.length} people` : name(it.payers[0]?.user_id || '');
        return (
          <Pressable key={`e-${it.id}`} onPress={() => onOpen(it.id)} style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.muted50 }]}>
            <CategoryIcon category={it.category} size={34} />
            <View style={styles.flex}>
              <View style={styles.titleRow}>
                <Text style={styles.itemTitle} numberOfLines={1}>{it.description}</Text>
                {it.locked && <Lock size={13} color={colors.muted400} />}
                {it.source === 'receipt' && <ScrollText size={13} color={colors.primary500} />}
              </View>
              <Text style={styles.sub}>{payer} paid {formatMinor(it.total_minor, it.currency)} · {label(it.category)} · {when}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.rowAmount, { color: netColor(net) }]}>{net === 0 ? '—' : `${net > 0 ? '+' : '−'}${formatMinor(Math.abs(net), it.currency)}`}</Text>
              {net !== 0 && !!approx(Math.abs(net), it.currency) && <Text style={styles.approx}>{approx(Math.abs(net), it.currency)}</Text>}
            </View>
            {it.can_edit && !it.locked && (
              <Pressable onPress={() => onEdit(it.id)} hitSlop={8} style={styles.editButton} accessibilityLabel={`Edit ${it.description}`}>
                <PenLine size={16} color={colors.muted500} />
              </Pressable>
            )}
          </Pressable>
        );
      })}</View>}

      {picking && (
        <Picker
          title={picking === 'category' ? 'Category' : 'Member'}
          options={picking === 'category'
            ? [{ value: '', label: 'All categories' }, ...CATEGORIES.map((c) => ({ value: c, label: label(c) }))]
            : [{ value: '', label: 'Everyone' }, ...Object.keys(users).map((id) => ({ value: id, label: name(id) }))]}
          onPick={(v) => { if (picking === 'category') setCategory(v); else setMember(v); setPicking(null); }}
          onClose={() => setPicking(null)}
        />
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: space(4) },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space(4), paddingBottom: space(10), gap: space(3) },
  historyContent: { paddingBottom: space(10) },
  flex: { flex: 1 },
  flexGap: { gap: 4 },
  tabs: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: space(4), marginTop: space(2), borderBottomWidth: 1, borderBottomColor: colors.muted200 },
  tab: { paddingVertical: space(3), paddingHorizontal: space(1.5), alignItems: 'center' },
  tabOn: {},
  tabText: { fontSize: 14, fontWeight: '600', color: colors.muted500 },
  tabTextOn: { color: colors.primary700, fontWeight: '700' },
  tabLine: { position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, backgroundColor: colors.primary700 },
  position: { margin: space(4), marginBottom: space(2), padding: space(5), borderRadius: 18, overflow: 'hidden', backgroundColor: CARD_GRADIENT.middle },
  positionLabel: { fontSize: 11, letterSpacing: 1.3, color: colors.primary100 },
  positionTitle: { marginTop: space(2), fontSize: 18, fontWeight: '600', color: colors.white },
  positionAmount: { fontSize: 26, fontWeight: '800' },
  positionApprox: { marginTop: 2, fontSize: 13, fontWeight: '600', color: colors.primary100 },
  posStats: { flexDirection: 'row', gap: space(2), marginTop: space(4) },
  posStat: { flex: 1, minWidth: 0, paddingHorizontal: space(3), paddingVertical: space(2.5), borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  posStatLabel: { fontSize: 11, color: colors.primary100 },
  posStatValue: { marginTop: 2, fontSize: 14, fontWeight: '700', color: colors.white },
  positionActions: { flexDirection: 'row', gap: space(2.5), marginTop: space(4) },
  positionButton: { flex: 1, minHeight: 44, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2) },
  positionAdd: { backgroundColor: 'rgba(47,34,70,0.6)' },
  positionSettle: { backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  positionButtonText: { color: colors.white, fontSize: 14, fontWeight: '700' },
  card: { padding: space(4), borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200, gap: space(2.5) },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.muted500 },
  currency: { fontSize: 13, color: colors.muted500 },
  net: { fontSize: 16, fontWeight: '700' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  stat: { flexBasis: '47%', flexGrow: 1, padding: space(3), borderRadius: 12, backgroundColor: colors.primary50 },
  statLabel: { fontSize: 12, color: colors.muted500 },
  statValue: { fontSize: 16, fontWeight: '700', color: colors.muted900, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2.5) },
  rowText: { flex: 1, fontSize: 14, color: colors.muted700 },
  rowAmount: { fontSize: 14, fontWeight: '600', color: colors.muted900 },
  approx: { fontSize: 11, color: colors.muted400, marginTop: 1 },
  payActions: { flexDirection: 'row', gap: space(4), marginTop: space(1.5) },
  payEdit: { fontSize: 13, fontWeight: '700', color: colors.primary700 },
  payUndo: { fontSize: 13, fontWeight: '700', color: colors.muted500 },
  editButton: { padding: space(1.5), marginLeft: space(1) },
  settledText: { color: colors.success700, fontWeight: '600', fontSize: 14 },
  memberName: { fontSize: 14, color: colors.muted900 },
  bold: { fontWeight: '700' },
  sub: { fontSize: 12, color: colors.muted500, fontWeight: '400' },
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space(2) },
  debtBlock: { gap: space(1.5) },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2) },
  payButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.sm, backgroundColor: colors.primary700 },
  payText: { fontSize: 13, fontWeight: '700', color: colors.white },
  outlineButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.sm, borderWidth: 1, borderColor: colors.muted200 },
  outlineText: { fontSize: 13, fontWeight: '600', color: colors.muted700 },
  smallButton: { paddingHorizontal: space(2.5), paddingVertical: space(1), borderRadius: radius.sm, backgroundColor: colors.primary50 },
  smallButtonText: { fontSize: 13, fontWeight: '600', color: colors.primary700 },
  note: { fontSize: 12, color: colors.muted400, paddingHorizontal: space(1) },
  total: { fontSize: 30, fontWeight: '800', color: colors.muted900 },
  blockTitle: { marginTop: space(3), fontSize: 15, fontWeight: '700', color: colors.muted900 },
  blockTitleTop: { fontSize: 16, fontWeight: '700', color: colors.muted900 },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.muted500 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) },
  tile: { flexBasis: '47%', flexGrow: 1, paddingHorizontal: space(3), paddingVertical: space(2.5), borderRadius: 12, backgroundColor: colors.primary50 },
  tileLabel: { fontSize: 11, fontWeight: '600', color: colors.muted500 },
  tileValue: { marginTop: 2, fontSize: 15, fontWeight: '700', color: colors.muted900 },
  donutCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  donutValue: { fontSize: 17, fontWeight: '800', color: colors.muted900 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingVertical: space(1.5), paddingHorizontal: space(1), borderRadius: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendPct: { width: 36, textAlign: 'right', fontSize: 12, color: colors.muted500 },
  monthChart: { height: 150, flexDirection: 'row', alignItems: 'flex-end', gap: space(3), marginTop: space(2) },
  monthCol: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  monthBar: { width: '70%', maxWidth: 26, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  monthValue: { fontSize: 10, fontWeight: '700', color: colors.primary700 },
  monthLabel: { fontSize: 11, color: colors.muted500 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.muted100, overflow: 'hidden', marginTop: 4 },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary500 },
  empty: { textAlign: 'center', color: colors.muted500, marginTop: space(8), paddingHorizontal: space(6) },
  chips: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(4), paddingTop: space(3) },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  chipsLast: { paddingBottom: space(4) },
  historyList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200 },
  chipOn: { borderColor: colors.primary600, backgroundColor: colors.primary50 },
  chipText: { fontSize: 13, color: colors.muted700 },
  chipTextOn: { color: colors.primary800, fontWeight: '600' },
  item: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.white, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.muted200, marginTop: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  itemTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.muted900 },
  payIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.success50 },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: space(5), paddingBottom: space(10), gap: space(3) },
  choices: { maxHeight: 360, marginHorizontal: -space(2) },
  choice: { paddingHorizontal: space(2), paddingVertical: space(2.5), borderRadius: radius.md },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: colors.muted900 },
  sheetText: { fontSize: 14, color: colors.muted600 },
  amount: { height: 52, borderWidth: 1, borderColor: colors.muted300, borderRadius: radius.md, paddingHorizontal: space(3), fontSize: 20, fontWeight: '600', color: colors.muted900 },
  option: { paddingVertical: space(3), paddingHorizontal: space(2), borderRadius: radius.sm },
  optionText: { fontSize: 15, color: colors.muted900 },
});

export default ChatExpensesScreen;
