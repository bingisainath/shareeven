// src/screens/expenses/ReceiptEditors.tsx
// Manual corrections on the receipt review: the AI can misread a line, miss a discount or a shop
// can print things oddly, so every line, discount, tax and fee can be edited, added or removed.
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';
import Avatar from '../common/Avatar';
import { Button } from '../common/ui';
import type { ReceiptUpdate } from '../../api/expenses';
import type { MemberInfo as Member } from '../../api/chat';
import { memberName } from '../../hooks/useMembers';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { colors, radius, space } from '../../theme';
import { RECEIPT_CATEGORIES } from '../../utils/receiptCategories';

export type ItemDraft = ReceiptUpdate['items'][number];
export type AdjustmentDraft = ReceiptUpdate['adjustments'][number];

export const DISCOUNT_KINDS = ['item_discount', 'promotion', 'store_discount', 'coupon'];
const KINDS: { kind: string; label: string }[] = [
  { kind: 'store_discount', label: 'Discount' },
  { kind: 'promotion', label: 'Deal (3 for 2…)' },
  { kind: 'tax', label: 'Tax' },
  { kind: 'service_charge', label: 'Service charge' },
  { kind: 'fee', label: 'Fee' },
  { kind: 'tip', label: 'Tip' },
];
export const kindLabel = (kind: string) => KINDS.find((k) => k.kind === kind)?.label
  || (kind === 'item_discount' || kind === 'coupon' ? 'Discount' : kind.replace('_', ' '));

const Sheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }> = ({ title, onClose, children, footer }) => {
  const keyboard = useKeyboardOffset();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View ref={keyboard.ref} style={[styles.backdrop, { paddingBottom: keyboard.offset }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space(3) }}>{children}</ScrollView>
          <View style={styles.footer}>{footer}</View>
        </View>
      </View>
    </Modal>
  );
};

const Field: React.FC<{ label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string; flex?: number }> = ({ label, value, onChange, numeric, placeholder, flex }) => (
  <View style={{ flex }}>
    <Text style={styles.label}>{label}</Text>
    <TextInput value={value} onChangeText={onChange} keyboardType={numeric ? 'decimal-pad' : 'default'} placeholder={placeholder}
      placeholderTextColor={colors.muted400} style={styles.input} accessibilityLabel={label} />
  </View>
);

function Segments<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={styles.segments}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[styles.segment, value === o.value && styles.segmentOn]} accessibilityState={{ selected: value === o.value }}>
          <Text style={[styles.segmentText, value === o.value && styles.segmentTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ one line on the receipt

export const ItemEditor: React.FC<{
  item: ItemDraft;
  isNew: boolean;
  discount: string; // amount saved on this line, '' for none
  members: Member[];
  nameOf: (id: string) => string;
  onSave: (item: ItemDraft, discount: string) => void;
  onRemove: () => void;
  onClose: () => void;
}> = ({ item, isNew, discount: startDiscount, members, nameOf, onSave, onRemove, onClose }) => {
  const [draft, setDraft] = useState(item);
  const [discount, setDiscount] = useState(startDiscount);
  const set = (patch: Partial<ItemDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const units = (id: string) => Number(draft.assignments.find((a) => a.user_id === id)?.value || 0);
  const setUnits = (id: string, value: number) => set({
    assignments: [...draft.assignments.filter((a) => a.user_id !== id), ...(value > 0 ? [{ user_id: id, value: String(value) }] : [])],
  });
  const valid = draft.name.trim() && /^\d+([.,]\d{1,3})?$/.test(draft.price.trim()) && Number(draft.quantity.replace(',', '.')) > 0;

  return (
    <Sheet title={isNew ? 'Add a line' : 'Edit line'} onClose={onClose} footer={
      <>
        {!isNew && <Button title="Remove" variant="danger" compact onPress={onRemove} />}
        <View style={{ flex: 1 }} />
        <Button title="Cancel" variant="secondary" compact onPress={onClose} />
        <Button title="Done" compact disabled={!valid} onPress={() => onSave({ ...draft, name: draft.name.trim(), price: draft.price.trim().replace(',', '.'), quantity: draft.quantity.trim().replace(',', '.') }, discount.trim().replace(',', '.'))} />
      </>
    }>
      <Field label="Name" value={draft.name} onChange={(name) => set({ name })} />
      <View style={styles.row}>
        <Field label="Quantity" value={draft.quantity} onChange={(quantity) => set({ quantity })} numeric flex={1} />
        <Field label="Line price" value={draft.price} onChange={(price) => set({ price })} numeric placeholder="0.00" flex={1} />
        <Field label="Saved" value={discount} onChange={setDiscount} numeric placeholder="0.00" flex={1} />
      </View>
      <Text style={styles.hint}>Line price is what's printed for the whole line. "Saved" is a discount on just this line (Clubcard, reduced…).</Text>

      <Text style={styles.label}>Category</Text>
      <View style={styles.categories}>
        {RECEIPT_CATEGORIES.map((c) => {
          const on = draft.category === c.key;
          return (
            <Pressable key={c.key} onPress={() => set({ category: on ? null : c.key })} style={[styles.categoryChip, on && styles.categoryChipOn]}
              accessibilityState={{ selected: on }}>
              <Text style={[styles.categoryText, on && styles.categoryTextOn]}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.label}>Split</Text>
      <Segments value={draft.split_mode === 'equal' ? 'equal' : 'quantity'} onChange={(mode) => set({
        split_mode: mode,
        assignments: draft.assignments.map((a) => ({ ...a, value: '1' })),
      })} options={[{ value: 'equal', label: 'Equally' }, { value: 'quantity', label: 'By how many each took' }]} />
      {members.map((m) => {
        const on = draft.assignments.some((a) => a.user_id === m.id);
        return (
          <View key={m.id} style={styles.person}>
            <Avatar uri={m.avatar} name={memberName(m)} size={28} />
            <Text style={styles.personName} numberOfLines={1}>{nameOf(m.id)}</Text>
            {draft.split_mode === 'equal' ? (
              <Switch value={on} onValueChange={(v) => setUnits(m.id, v ? 1 : 0)} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white}
                accessibilityLabel={`${nameOf(m.id)} shares this`} />
            ) : (
              <View style={styles.stepper}>
                <Pressable onPress={() => setUnits(m.id, Math.max(0, units(m.id) - 1))} style={styles.step} accessibilityLabel={`One less for ${nameOf(m.id)}`}><Minus size={16} color={colors.muted700} /></Pressable>
                <Text style={styles.units}>{units(m.id)}</Text>
                <Pressable onPress={() => setUnits(m.id, units(m.id) + 1)} style={styles.step} accessibilityLabel={`One more for ${nameOf(m.id)}`}><Plus size={16} color={colors.muted700} /></Pressable>
              </View>
            )}
          </View>
        );
      })}
    </Sheet>
  );
};

// ------------------------------------------------------------------ discount, deal, tax, fee, tip

export const AdjustmentEditor: React.FC<{
  adjustment: AdjustmentDraft;
  isNew: boolean;
  items: ItemDraft[];
  members: Member[];
  nameOf: (id: string) => string;
  onSave: (a: AdjustmentDraft) => void;
  onRemove: () => void;
  onClose: () => void;
}> = ({ adjustment, isNew, items, members, nameOf, onSave, onRemove, onClose }) => {
  const [a, setA] = useState(adjustment);
  const set = (patch: Partial<AdjustmentDraft>) => setA((d) => ({ ...d, ...patch }));
  const discount = DISCOUNT_KINDS.includes(a.kind);
  const usesPercent = a.percent !== null;
  const printed = a.source === 'printed';
  useEffect(() => {
    // Shares of a fee only make sense for fees; deals and discounts follow the items
    if (discount && (a.allocation === 'equal' || a.allocation === 'assign')) set({ allocation: 'proportional', assignee_ids: [] });
  }, [discount]); // eslint-disable-line react-hooks/exhaustive-deps
  const amountOk = usesPercent ? Number((a.percent || '').replace(',', '.')) > 0 : /^-?\d+([.,]\d{1,3})?$/.test((a.amount || '').trim());
  const toggleItem = (n: number) => set({ item_indexes: a.item_indexes.includes(n) ? a.item_indexes.filter((i) => i !== n) : [...a.item_indexes, n].sort((x, y) => x - y) });

  return (
    <Sheet title={isNew ? 'Add discount, tax or fee' : `Edit ${kindLabel(a.kind).toLowerCase()}`} onClose={onClose} footer={
      <>
        {!isNew && <Button title="Remove" variant="danger" compact onPress={onRemove} />}
        <View style={{ flex: 1 }} />
        <Button title="Cancel" variant="secondary" compact onPress={onClose} />
        <Button title="Done" compact disabled={!amountOk || !a.label.trim() || (a.allocation === 'assign' && !a.assignee_ids.length)}
          onPress={() => onSave({ ...a, label: a.label.trim(), amount: (a.amount || '').trim().replace(',', '.'), enabled: true })} />
      </>
    }>
      <View style={styles.kinds}>
        {KINDS.map((k) => {
          const on = a.kind === k.kind || (k.kind === 'store_discount' && (a.kind === 'item_discount' || a.kind === 'coupon'));
          return (
            <Pressable key={k.kind} onPress={() => set({ kind: k.kind, label: !a.label.trim() || KINDS.some((x) => x.label === a.label) ? k.label : a.label })}
              style={[styles.kind, on && styles.segmentOn]} accessibilityState={{ selected: on }}>
              <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{k.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Field label="Label" value={a.label} onChange={(label) => set({ label })} />
      <View style={styles.row}>
        {usesPercent
          ? <Field label="Percent off" value={a.percent || ''} onChange={(percent) => set({ percent })} numeric flex={1} />
          : <Field label={discount ? 'Amount saved' : 'Amount'} value={discount ? (a.amount || '').replace(/^-/, '') : a.amount || ''} onChange={(amount) => set({ amount })} numeric placeholder="0.00" flex={1} />}
        {discount && (
          <View style={{ justifyContent: 'flex-end' }}>
            <Segments value={usesPercent ? 'percent' : 'amount'} onChange={(v) => set({ percent: v === 'percent' ? (a.percent || '10') : null })}
              options={[{ value: 'amount', label: '€ / ₹' }, { value: 'percent', label: '%' }]} />
          </View>
        )}
      </View>
      <View style={styles.person}>
        <View style={{ flex: 1 }}>
          <Text style={styles.personName}>Printed on the receipt</Text>
          <Text style={styles.hint}>{printed ? 'Counts towards the receipt total.' : 'Your own extra (e.g. a tip you add): not compared with the receipt total.'}</Text>
        </View>
        <Switch value={printed} onValueChange={(v) => set({ source: v ? 'printed' : 'manual' })} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white} />
      </View>

      <Text style={styles.label}>Applies to</Text>
      <Segments value={a.item_indexes.length ? 'items' : 'bill'} onChange={(v) => set({ item_indexes: v === 'bill' ? [] : a.item_indexes.length ? a.item_indexes : [0] })}
        options={[{ value: 'bill', label: 'Whole bill' }, { value: 'items', label: 'Some items' }]} />
      {a.item_indexes.length > 0 && items.map((it, n) => (
        <Pressable key={n} onPress={() => toggleItem(n)} style={styles.itemRow} accessibilityState={{ checked: a.item_indexes.includes(n) }}>
          <View style={[styles.check, a.item_indexes.includes(n) && styles.checkOn]} />
          <Text style={styles.itemName} numberOfLines={1}>{it.quantity !== '1' ? `${it.quantity}× ` : ''}{it.name}</Text>
          <Text style={styles.itemPrice}>{it.price}</Text>
        </Pressable>
      ))}

      {discount && a.item_indexes.length > 1 && (
        <>
          <Text style={styles.label}>Share the deal</Text>
          <Segments value={a.allocation === 'per_unit' ? 'per_unit' : 'proportional'} onChange={(allocation) => set({ allocation })}
            options={[{ value: 'per_unit', label: 'Each item costs the same' }, { value: 'proportional', label: 'Same % off each' }]} />
          <Text style={styles.hint}>
            {a.allocation === 'per_unit' ? 'Any 3 for 2: the 3 items together cost the price of 2, and each of them costs a third of that.' : 'Each item is reduced by the same percentage, so dearer items get more off.'}
          </Text>
        </>
      )}
      {!discount && (
        <>
          <Text style={styles.label}>Who pays it</Text>
          <Segments value={a.allocation === 'per_unit' ? 'proportional' : a.allocation} onChange={(allocation) => set({ allocation, assignee_ids: allocation === 'assign' ? a.assignee_ids : [] })}
            options={[{ value: 'proportional', label: 'By what each had' }, { value: 'equal', label: 'Equally' }, { value: 'assign', label: 'Someone' }]} />
          {a.allocation === 'assign' && members.map((m) => (
            <View key={m.id} style={styles.person}>
              <Avatar uri={m.avatar} name={memberName(m)} size={28} />
              <Text style={styles.personName} numberOfLines={1}>{nameOf(m.id)}</Text>
              <Switch value={a.assignee_ids.includes(m.id)} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white}
                onValueChange={(v) => set({ assignee_ids: v ? [...a.assignee_ids, m.id] : a.assignee_ids.filter((u) => u !== m.id) })} />
            </View>
          ))}
        </>
      )}
    </Sheet>
  );
};

const styles = StyleSheet.create({
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5) },
  categoryChip: { paddingHorizontal: space(2.5), paddingVertical: 5, borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted200 },
  categoryChipOn: { borderColor: colors.primary600, backgroundColor: colors.primary50 },
  categoryText: { fontSize: 12, color: colors.muted600 },
  categoryTextOn: { color: colors.primary700, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '88%', backgroundColor: colors.white, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: space(4), paddingBottom: space(6), gap: space(3) },
  title: { fontSize: 17, fontWeight: '700', color: colors.muted900 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingTop: space(2), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200 },
  row: { flexDirection: 'row', gap: space(2) },
  label: { fontSize: 12, fontWeight: '600', color: colors.muted600, marginBottom: 4 },
  input: { height: 42, borderWidth: 1, borderColor: colors.muted300, borderRadius: radius.md, paddingHorizontal: space(3), fontSize: 15, color: colors.muted900 },
  hint: { fontSize: 12, color: colors.muted500 },
  segments: { flexDirection: 'row', borderRadius: radius.md, borderWidth: 1, borderColor: colors.muted300, overflow: 'hidden' },
  segment: { flex: 1, paddingVertical: space(2), paddingHorizontal: space(2), alignItems: 'center', backgroundColor: colors.white },
  segmentOn: { backgroundColor: colors.primary700, borderColor: colors.primary700 },
  segmentText: { fontSize: 13, color: colors.muted700, fontWeight: '600', textAlign: 'center' },
  segmentTextOn: { color: colors.white },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5) },
  kind: { paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted300 },
  person: { flexDirection: 'row', alignItems: 'center', gap: space(2.5) },
  personName: { flex: 1, fontSize: 15, color: colors.muted900 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  step: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.muted100, alignItems: 'center', justifyContent: 'center' },
  units: { minWidth: 20, textAlign: 'center', fontSize: 15, fontWeight: '700', color: colors.muted900 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingVertical: space(1.5) },
  check: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: colors.muted300 },
  checkOn: { backgroundColor: colors.primary600, borderColor: colors.primary600 },
  itemName: { flex: 1, fontSize: 14, color: colors.muted900 },
  itemPrice: { fontSize: 14, color: colors.muted600 },
});
