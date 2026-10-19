// src/screens/expenses/ExpenseDetailScreen.tsx
import React, { useCallback, useEffect, useState } from 'react';
import { firstCharacter } from '../../utils/initials';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ChevronDown, Lock, LockOpen, PenLine, Plus, RotateCcw, Trash2 } from 'lucide-react-native';
import { Button } from '../../components/common/ui';
import { Expense, expenseService, HistoryEntry, Receipt } from '../../api/expenses';
import { errorMessage } from '../../api/client';
import { mediaUrl } from '../../config';
import { useAuth } from '../../store/auth';
import { formatMinor } from '../../utils/money';
import { shareLines } from '../../utils/shareBreakdown';
import { colors, radius, space } from '../../theme';
import type { AppStackParams } from '../../navigation/types';
import CategoryIcon from '../../components/expenses/CategoryIcon';
import { Segmented } from './AddExpenseScreen';
import { memberName, useChatMoney, useExpenseChanges } from '../../hooks/useMembers';
import { showAlert } from '../../components/common/Dialog';

const ACTION_ICONS = { created: Plus, updated: PenLine, deleted: Trash2, restored: RotateCcw, locked: Lock, unlocked: LockOpen };

const ExpenseDetailScreen: React.FC<NativeStackScreenProps<AppStackParams, 'ExpenseDetail'>> = ({ route, navigation }) => {
  const { expenseId } = route.params;
  const me = useAuth((s) => s.user)!;
  const [expense, setExpense] = useState<Expense | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [tab, setTab] = useState('details');
  const [receipt, setReceipt] = useState<Receipt | null>(null); // explains each share of a receipt expense
  const [open, setOpen] = useState<string | null>(null); // whose items are shown
  const { members } = useChatMoney(expense?.conversation_id);

  const load = useCallback(async () => {
    try {
      const [e, h] = await Promise.all([expenseService.get(expenseId), expenseService.history(expenseId)]);
      setExpense(e);
      setHistory(h);
      if (e.receipt_id && e.split_mode === 'itemized') {
        expenseService.getReceipt(e.receipt_id).then(setReceipt).catch(() => setReceipt(null));
      }
      navigation.setOptions({ title: e.description });
    } catch (err) {
      showAlert("Couldn't load the expense", errorMessage(err));
      navigation.goBack();
    }
  }, [expenseId, navigation]);

  useEffect(() => navigation.addListener('focus', () => { load(); }), [navigation, load]);
  useExpenseChanges(expense?.conversation_id, load);

  if (!expense) return <View style={styles.center}><ActivityIndicator color={colors.primary700} /></View>;

  const nameOf = (id: string) => (id === me.id ? 'You' : memberName(members.find((m) => m.id === id)));
  const myShare = expense.shares.find((s) => s.user_id === me.id)?.amount_minor || 0;
  const myPaid = expense.payers.find((p) => p.user_id === me.id)?.amount_minor || 0;
  const net = myPaid - myShare;
  const initials = (id: string) => {
    if (id === me.id) return 'You';
    const words = nameOf(id).trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? firstCharacter(words[0]) + firstCharacter(words[1]) : firstCharacter(words[0] || '?')).toUpperCase();
  };

  // One calm purple: a badge per person, thin lines between people, your own row lightly tinted.
  // On a receipt split, tapping someone shows the items their share is made of.
  const personRow = (userId: string, minor: number, options: { label?: string; breakdown?: boolean; last?: boolean } = {}) => {
    const lines = options.breakdown && receipt ? shareLines(receipt, userId, minor) : null;
    const itemCount = lines?.filter((l) => l.key.startsWith('i')).length || 0;
    const isOpen = !!lines && open === userId;
    const mine = userId === me.id;
    return (
      <View key={userId} style={[mine && styles.mine, !options.last && styles.divider]}>
        <Pressable
          disabled={!lines}
          onPress={() => setOpen(isOpen ? null : userId)}
          accessibilityRole={lines ? 'button' : undefined}
          accessibilityState={lines ? { expanded: isOpen } : undefined}
          style={({ pressed }) => [styles.line, pressed && styles.pressed]}
        >
          <View style={[styles.badge, mine && styles.badgeMine]}>
            <Text style={[styles.badgeText, mine && styles.badgeTextMine]}>{initials(userId)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.lineName, mine && styles.lineNameMine]} numberOfLines={1}>
              {nameOf(userId)}{options.label ? <Text style={styles.lineLabel}> {options.label}</Text> : null}
            </Text>
            {lines && <Text style={styles.lineSub}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>}
          </View>
          <Text style={styles.lineAmount}>{formatMinor(minor, expense.currency)}</Text>
          {lines && <ChevronDown size={16} color={colors.muted400} style={isOpen ? { transform: [{ rotate: '180deg' }] } : undefined} />}
        </Pressable>
        {isOpen && lines && (
          <View style={styles.items}>
            {lines.map((l, n) => (
              <View key={l.key} style={[styles.itemRow, n > 0 && styles.itemDivider]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{l.label}</Text>
                  {l.detail && <Text style={styles.itemDetail}>{l.detail}</Text>}
                </View>
                <Text style={styles.itemAmount}>{formatMinor(l.amount, expense.currency)}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  const act = async (action: () => Promise<unknown>) => {
    try { await action(); load(); } catch (err) { showAlert('Something went wrong', errorMessage(err)); }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <CategoryIcon category={expense.category} size={60} />
        <Text style={styles.total}>{expense.total_display}</Text>
        <Text style={styles.sub}>
          {expense.spent_at ? new Date(expense.spent_at).toLocaleDateString() : ''}{expense.source === 'receipt' ? ' · from a receipt' : ''}{expense.locked ? ' · locked' : ''}
        </Text>
        {expense.deleted && <Text style={[styles.sub, { color: colors.danger600, fontWeight: '600' }]}>This expense was deleted</Text>}
        <Text style={[styles.net, { color: net > 0 ? colors.success700 : net < 0 ? colors.danger600 : colors.muted500 }]}>
          {net > 0 ? `You get back ${formatMinor(net, expense.currency)}` : net < 0 ? `You owe ${formatMinor(-net, expense.currency)}` : myShare ? 'You’re even on this one' : 'You’re not involved'}
        </Text>
      </View>

      <View style={styles.tabs}>
        <Segmented value={tab} options={[['details', 'Details'], ['history', `History (${history.length})`]]} onChange={setTab} />
      </View>

      {tab === 'details' ? (
        <View style={styles.card}>
          <Text style={styles.section}>Paid by</Text>
          <View style={styles.lines}>
            {expense.payers.map((p, n) => personRow(p.user_id, p.amount_minor, { last: n === expense.payers.length - 1 }))}
          </View>
          <Text style={[styles.section, { marginTop: space(4) }]}>Split {expense.split_mode === 'itemized' ? 'by item' : expense.split_mode === 'equal' ? 'equally' : `by ${expense.split_mode}`}</Text>
          <View style={styles.lines}>
            {expense.shares.map((s, n) => personRow(s.user_id, s.amount_minor, {
              label: s.split_value && expense.split_mode === 'percent' ? `(${s.split_value}%)` : undefined,
              breakdown: expense.split_mode === 'itemized',
              last: n === expense.shares.length - 1,
            }))}
          </View>
          {receipt && expense.split_mode === 'itemized' && <Text style={styles.hint}>Tap someone to see their items.</Text>}
          {expense.receipt_images.length > 0 && (
            <>
              <Text style={[styles.section, { marginTop: space(4) }]}>Receipt</Text>
              <View style={styles.images}>
                {expense.receipt_images.map((src) => <Image key={src} source={{ uri: mediaUrl(src) }} style={styles.receipt} />)}
              </View>
            </>
          )}
        </View>
      ) : (
        <View style={styles.card}>
          {history.map((h) => {
            const Icon = ACTION_ICONS[h.action] || PenLine;
            return (
              <View key={h.id} style={styles.event}>
                <View style={styles.eventIcon}><Icon size={14} color={colors.primary700} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.eventText}><Text style={{ fontWeight: '700' }}>{h.actor ? (h.actor.id === me.id ? 'You' : h.actor.username) : 'Someone'}</Text> {h.summary}</Text>
                  <Text style={styles.eventTime}>{new Date(h.created_at).toLocaleString()}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.actions}>
        {!expense.deleted && expense.can_edit && (
          <Button title={expense.split_mode === 'itemized' ? 'Edit details' : 'Edit'} icon={PenLine}
            onPress={() => navigation.navigate('AddExpense', { conversationId: expense.conversation_id, expenseId: expense.id })} />
        )}
        {!expense.deleted && expense.can_edit && expense.receipt_id && (
          <Button title="Edit items" variant="secondary" onPress={() => navigation.navigate('ScanReceipt', { conversationId: expense.conversation_id, receiptId: expense.receipt_id! })} />
        )}
        {expense.can_admin && !expense.deleted && (
          <Button title={expense.locked ? 'Unlock' : 'Lock'} variant="secondary" icon={expense.locked ? LockOpen : Lock} onPress={() => act(() => expenseService.lock(expense.id, !expense.locked))} />
        )}
        {expense.can_delete && !expense.locked && (
          <Button title="Delete" variant="danger" icon={Trash2} onPress={() => showAlert('Delete this expense?', 'It can be restored later.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => act(() => expenseService.remove(expense.id)) },
          ])} />
        )}
        {expense.deleted && (expense.can_admin || expense.created_by === me.id) && (
          <Button title="Restore" icon={RotateCcw} onPress={() => act(() => expenseService.restore(expense.id))} />
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space(4), paddingBottom: space(12), backgroundColor: colors.background },
  hero: { alignItems: 'center', paddingVertical: space(4) },
  total: { marginTop: space(3), fontSize: 32, fontWeight: '700', color: colors.muted900 },
  sub: { marginTop: space(1), fontSize: 13, color: colors.muted500 },
  net: { marginTop: space(2), fontSize: 15, fontWeight: '600' },
  tabs: { alignItems: 'center', marginVertical: space(3) },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: space(4), borderWidth: 1, borderColor: colors.muted200 },
  section: { fontSize: 13, fontWeight: '700', color: colors.muted600, marginBottom: space(1.5) },
  lines: { borderWidth: 1, borderColor: colors.muted200, borderRadius: radius.lg, overflow: 'hidden' },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.muted200 },
  mine: { backgroundColor: colors.primary50 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(2.5), paddingHorizontal: space(3) },
  pressed: { backgroundColor: colors.primary100 },
  badge: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary100, alignItems: 'center', justifyContent: 'center' },
  badgeMine: { backgroundColor: colors.primary600 },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.primary700 },
  badgeTextMine: { color: colors.white },
  lineName: { fontSize: 15, fontWeight: '500', color: colors.muted900 },
  lineNameMine: { fontWeight: '700', color: colors.primary800 },
  lineSub: { fontSize: 12, color: colors.muted500, marginTop: 1 },
  lineLabel: { fontWeight: '400', color: colors.muted500 },
  lineAmount: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  items: { marginHorizontal: space(3), marginBottom: space(3), borderWidth: 1, borderColor: colors.primary100, borderRadius: radius.md, backgroundColor: colors.white },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3), paddingVertical: space(2), paddingHorizontal: space(3) },
  itemDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.primary100 },
  itemName: { fontSize: 13, color: colors.muted900 },
  itemDetail: { fontSize: 12, color: colors.muted500, marginTop: 1 },
  itemAmount: { fontSize: 13, color: colors.muted900 },
  hint: { marginTop: space(1.5), fontSize: 12, color: colors.muted500 },
  images: { flexDirection: 'row', gap: space(2) },
  receipt: { width: 80, height: 104, borderRadius: radius.sm, backgroundColor: colors.muted100 },
  event: { flexDirection: 'row', gap: space(3), paddingVertical: space(2) },
  eventIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary50, alignItems: 'center', justifyContent: 'center' },
  eventText: { fontSize: 14, color: colors.muted900 },
  eventTime: { fontSize: 12, color: colors.muted500, marginTop: 2 },
  actions: { marginTop: space(4), gap: space(2) },
});

export default ExpenseDetailScreen;
