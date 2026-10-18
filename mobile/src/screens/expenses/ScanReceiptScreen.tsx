// src/screens/expenses/ScanReceiptScreen.tsx
// Photograph a receipt -> the server's AI reads it -> tap who each item is for -> save.
// Same flow and rules as web/src/components/expenses/ReceiptScan.tsx + ReceiptReview.tsx.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Asset, launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { cameraAllowed } from '../../utils/camera';
import { Camera, Images, X } from 'lucide-react-native';
import Avatar from '../../components/common/Avatar';
import { Banner, Button } from '../../components/common/ui';
import { api, errorMessage } from '../../api/client';
import { expenseService, Receipt, ReceiptUpdate, ScanStep } from '../../api/expenses';
import { onServerEvent } from '../../store/chat';
import { useAuth } from '../../store/auth';
import { formatMinor, parseMajor, toMajorString } from '../../utils/money';
import { colors, radius, space } from '../../theme';
import type { AppStackParams } from '../../navigation/types';
import { memberName, useChatMoney } from '../../hooks/useMembers';
import CurrencyPicker from '../../components/expenses/CurrencyPicker';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Pencil, Plus, ScanLine, Sparkles } from 'lucide-react-native';
import ReceiptLine from '../../components/expenses/ReceiptLine';
import { mediaUrl } from '../../config';
import { categoryLabel } from '../../utils/receiptCategories';
import { AdjustmentDraft, AdjustmentEditor, DISCOUNT_KINDS, ItemDraft, ItemEditor, kindLabel } from '../../components/expenses/ReceiptEditors';
import { showAlert } from '../../components/common/Dialog';

const MAX_PHOTOS = 4;
const PRESETS = [10, 15, 20];

async function uploadPhoto(asset: Asset): Promise<string> {
  const form = new FormData();
  form.append('file', { uri: asset.uri, type: asset.type || 'image/jpeg', name: asset.fileName || 'receipt.jpg' } as any);
  const r = await api.post('/media/upload', form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 });
  return r.data.data.url as string;
}

function toDraft(r: Receipt): ReceiptUpdate {
  const currency = r.currency || 'EUR';
  return {
    store_name: r.store_name,
    currency,
    printed_total: r.printed_total_minor === null ? null : toMajorString(r.printed_total_minor, currency),
    items: r.items.map((i) => ({
      id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, price: toMajorString(i.gross_minor, currency),
      category: i.category, flags: i.flags, split_mode: i.split_mode, assignments: i.assignments,
    })),
    adjustments: r.adjustments.map((a) => ({
      kind: a.kind, label: a.label, amount: toMajorString(a.amount_minor, currency), percent: a.percent, item_indexes: a.item_indexes,
      allocation: a.allocation, assignee_ids: a.assignee_ids, source: a.source, enabled: a.enabled,
    })),
    payers: r.payers.length === 1 ? [{ user_id: r.payers[0].user_id, amount: '0' }] : r.payers.length > 1
      ? r.payers.map((p) => ({ user_id: p.user_id, amount: toMajorString(p.amount_minor, currency) })) : null,
  };
}

const ScanReceiptScreen: React.FC<NativeStackScreenProps<AppStackParams, 'ScanReceipt'>> = ({ route, navigation }) => {
  const { conversationId } = route.params;
  const me = useAuth((s) => s.user)!;
  const { members } = useChatMoney(conversationId);
  const [photos, setPhotos] = useState<Asset[]>([]);
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<'pick' | 'uploading' | 'reading' | 'review'>(route.params.receiptId ? 'reading' : 'pick');
  const [receiptId, setReceiptId] = useState<string | undefined>(route.params.receiptId);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [steps, setSteps] = useState<ScanStep[]>([]); // what the AI has done so far, the last one in progress
  const [seconds, setSeconds] = useState(0);
  const [draft, setDraft] = useState<ReceiptUpdate | null>(null);
  const [pickingCurrency, setPickingCurrency] = useState(false);
  const [editingTotal, setEditingTotal] = useState(false);
  const [editingItem, setEditingItem] = useState<number | 'new' | null>(null);
  const [lineShown, setLineShown] = useState<Record<number, boolean>>({}); // the printed line under an item
  const [painter, setPainter] = useState<string | null>(null); // quick assign: tapping an item toggles this person
  const [editingAdjustment, setEditingAdjustment] = useState<number | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestNo = useRef(0);

  useEffect(() => navigation.setOptions({ title: stage === 'review' ? 'Who is each item for?' : 'Scan receipt' }), [navigation, stage]);

  // ---- 1. photos
  const add = async (source: 'camera' | 'library') => {
    const options = { mediaType: 'photo' as const, quality: 0.8 as const, maxWidth: 2600, maxHeight: 2600 };
    if (source === 'camera' && !(await cameraAllowed())) return;
    const result = source === 'camera'
      ? await launchCamera({ ...options, saveToPhotos: false })
      : await launchImageLibrary({ ...options, selectionLimit: MAX_PHOTOS - photos.length });
    if (result.errorCode) showAlert("Couldn't open the " + (source === 'camera' ? 'camera' : 'photos'), result.errorMessage || result.errorCode);
    if (result.assets?.length) setPhotos((p) => [...p, ...result.assets!].slice(0, MAX_PHOTOS));
  };

  const start = async () => {
    setStage('uploading');
    try {
      const urls = [];
      for (const photo of photos) urls.push(await uploadPhoto(photo));
      const created = await expenseService.scanReceipt(conversationId, urls, note.trim());
      setReceiptId(created.id);
      setSteps([]);
      setStage('reading');
    } catch (e) {
      showAlert("Couldn't start the scan", errorMessage(e));
      setStage('pick');
    }
  };

  // ---- 2. wait for the AI (WebSocket event, with a slow poll as a safety net)
  const addStep = useCallback((next: ScanStep) => {
    setSteps((current) => (current.some((s) => s.step === next.step) ? current : [...current, next]));
  }, []);

  const check = useCallback(async () => {
    if (!receiptId) return;
    const r = await expenseService.getReceipt(receiptId);
    if (r.status === 'processing') {
      if (r.progress) addStep(r.progress);
      return;
    }
    setReceipt(r);
    setDraft(toDraft(r));
    setStage('review');
  }, [receiptId, addStep]);

  useEffect(() => {
    if (stage !== 'reading' || !receiptId) return;
    check().catch(() => undefined);
    const off = onServerEvent((e) => {
      if (e.receiptId !== receiptId) return;
      if (e.type === 'receipt_scan_ready') check().catch(() => undefined);
      if (e.type === 'receipt_scan_progress' && e.step && e.label) addStep({ step: e.step, label: e.label });
    });
    const poll = setInterval(() => check().catch(() => undefined), 5000);
    const started = Date.now();
    setSeconds(0);
    const tick = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => { off(); clearInterval(poll); clearInterval(tick); };
  }, [stage, receiptId, check, addStep]);

  // ---- 3. review: every change is saved and recalculated on the server
  const change = (update: (d: ReceiptUpdate) => ReceiptUpdate) => {
    setDraft((d) => {
      const next = update(d!);
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => push(next), 450);
      return next;
    });
  };

  const push = async (body: ReceiptUpdate) => {
    const mine = ++requestNo.current;
    setSyncing(true);
    try {
      const updated = await expenseService.updateReceipt(receiptId!, body);
      if (mine === requestNo.current) {
        setReceipt(updated);
        setDraft((d) => (d && d.items.length === updated.items.length ? { ...d, items: d.items.map((it, n) => ({ ...it, id: updated.items[n].id })) } : d));
      }
    } catch (e) {
      if (mine === requestNo.current) showAlert("Couldn't update", errorMessage(e));
    } finally {
      if (mine === requestNo.current) setSyncing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; await push(draft!); }
      await expenseService.saveReceipt(receiptId!, { description: receipt?.store_name || undefined });
      navigation.goBack();
    } catch (e) {
      showAlert("Couldn't save", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- manual corrections
  const lineDiscounts = (d: ReceiptUpdate, n: number) =>
    d.adjustments.filter((a) => DISCOUNT_KINDS.includes(a.kind) && a.item_indexes.length === 1 && a.item_indexes[0] === n);

  const saveItem = (n: number | 'new', item: ItemDraft, saved: string) => change((d) => {
    const index = n === 'new' ? d.items.length : n;
    const items = n === 'new' ? [...d.items, item] : d.items.map((it, i) => (i === n ? item : it));
    const old = lineDiscounts(d, index);
    const keep = d.adjustments.filter((a) => !old.includes(a));
    const amount = Number(saved) || 0;
    const adjustments = amount > 0 ? [...keep, {
      kind: old[0]?.kind || 'item_discount', label: old[0]?.label || 'Discount', amount: String(amount), percent: null,
      item_indexes: [index], allocation: 'proportional' as const, assignee_ids: [], source: 'printed' as const, enabled: true,
    }] : keep;
    return { ...d, items, adjustments };
  });

  const removeItem = (n: number) => change((d) => ({
    ...d,
    items: d.items.filter((_, i) => i !== n),
    // Re-point discounts at the remaining lines; drop ones that only belonged to this line
    adjustments: d.adjustments.flatMap((a) => {
      if (!a.item_indexes.length) return [a];
      const indexes = a.item_indexes.filter((i) => i !== n).map((i) => (i > n ? i - 1 : i));
      return indexes.length ? [{ ...a, item_indexes: indexes }] : [];
    }),
  }));

  const saveAdjustment = (n: number | 'new', a: AdjustmentDraft) => change((d) => ({
    ...d, adjustments: n === 'new' ? [...d.adjustments, a] : d.adjustments.map((x, i) => (i === n ? a : x)),
  }));

  // ---------- render
  if (stage === 'pick') {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.lead}>Photograph the whole receipt, flat and well lit. Long receipt? Add up to {MAX_PHOTOS} photos, top to bottom.</Text>
        <View style={styles.thumbs}>
          {photos.map((p, i) => (
            <View key={p.uri} style={styles.thumb}>
              <Image source={{ uri: p.uri }} style={styles.thumbImage} />
              <Pressable onPress={() => setPhotos((list) => list.filter((_, n) => n !== i))} style={styles.remove} accessibilityLabel="Remove photo">
                <X size={14} color={colors.white} />
              </Pressable>
            </View>
          ))}
        </View>
        {photos.length < MAX_PHOTOS && (
          <View style={styles.pickRow}>
            <Button title="Take photo" icon={Camera} onPress={() => add('camera')} style={styles.flex} />
            <Button title="Gallery" icon={Images} variant="secondary" onPress={() => add('library')} style={styles.flex} />
          </View>
        )}
        <TextInput
          value={note}
          onChangeText={setNote}
          maxLength={300}
          multiline
          placeholder="Note for the scan (optional), e.g. “ignore the bag charge”"
          placeholderTextColor={colors.muted400}
          style={styles.note}
          accessibilityLabel="Note for the scan"
        />
        <Button title="Read receipt" onPress={start} disabled={!photos.length} style={{ marginTop: space(4) }} />
      </ScrollView>
    );
  }

  if (stage === 'uploading' || stage === 'reading' || !receipt || !draft) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary700} />
        <Text style={styles.waitTitle}>{stage === 'uploading' ? 'Uploading…' : 'Reading the receipt…'}</Text>
        <Text style={styles.waitText}>{stage === 'reading' && seconds > 0 ? `${seconds}s · ` : ''}This usually takes 10–40 seconds.</Text>
        {stage === 'reading' && steps.length > 0 && (
          <View style={styles.steps} accessibilityLiveRegion="polite">
            {steps.map((s, i) => {
              const done = i < steps.length - 1;
              return (
                <View key={s.step} style={styles.stepRow}>
                  {done ? <Check size={16} color={colors.success600} /> : <ActivityIndicator size="small" color={colors.primary600} />}
                  <Text style={[styles.stepText, done && styles.stepDone]}>{s.label}</Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  }

  if (receipt.status === 'failed') {
    return (
      <View style={styles.center}>
        <Text style={styles.waitTitle}>Couldn’t read this receipt</Text>
        <Text style={[styles.waitText, { color: colors.danger600 }]}>{receipt.error}</Text>
        <Button title="Enter it manually" variant="secondary" onPress={() => navigation.replace('AddExpense', { conversationId })} style={{ marginTop: space(4) }} />
      </View>
    );
  }

  const currency = draft.currency;
  const totals = receipt.totals;
  const unassigned = new Set(totals?.unassigned_item_indexes || []);
  const nameOf = (id: string) => (id === me.id ? 'You' : memberName(members.find((m) => m.id === id)));
  const single = draft.payers?.length === 1 ? draft.payers[0].user_id : receipt.uploaded_by || me.id;
  const difference = totals?.difference_minor;
  const linesTotal = totals ? totals.computed_total_minor - (totals.outside_receipt_minor || 0) : 0;
  // Save only when every item has someone and the lines add up to the receipt's total
  const blocking = receipt.calc_error
    || (unassigned.size ? 'Choose who the highlighted items are for' : null)
    || (difference ? `The items add up to ${formatMinor(linesTotal, currency)}, but the receipt total is ${formatMinor(totals!.printed_total_minor, currency)}. Fix a price, a discount or the receipt total.` : null);

  // What the summary card and the people row show
  const discounts = receipt.adjustments.filter((a) => a.enabled && DISCOUNT_KINDS.includes(a.kind) && a.amount_minor < 0);
  const savedMinor = -discounts.reduce((sum, a) => sum + a.amount_minor, 0);
  const personal = draft.items.filter((it) => !it.flags.includes('voided') && it.assignments.length === 1 && members.length > 1);
  const unsure = receipt.items.filter((i) => i.confidence !== null && i.confidence !== undefined && i.confidence < 0.6).length;
  const inExpense = (userId: string) => draft.items.some((it) => it.assignments.some((a) => a.user_id === userId));
  const toggleEverywhere = (userId: string) => {
    const remove = inExpense(userId);
    change((d) => ({
      ...d,
      items: d.items.map((it) => {
        const has = it.assignments.some((a) => a.user_id === userId);
        if (remove) return has ? { ...it, assignments: it.assignments.filter((a) => a.user_id !== userId) } : it;
        return has ? it : { ...it, assignments: [...it.assignments, { user_id: userId, value: '1' }] };
      }),
    }));
  };

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.store} numberOfLines={1}>{receipt.store_name || 'Receipt'}</Text>
          <Pressable onPress={() => setPickingCurrency(true)} style={styles.currency} accessibilityLabel={`Currency ${currency}, change`}>
            <Text style={styles.currencyText}>{currency}</Text>
            <ChevronDown size={16} color={colors.primary700} />
          </Pressable>
        </View>
        <View style={[styles.totalRow, !!difference && styles.totalRowWrong]}>
          <Text style={styles.totalLabel}>Receipt total</Text>
          {editingTotal ? (
            <TextInput autoFocus keyboardType="decimal-pad" defaultValue={draft.printed_total || ''} style={styles.totalInput} accessibilityLabel="Receipt total"
              onEndEditing={(e) => { setEditingTotal(false); change((d) => ({ ...d, printed_total: e.nativeEvent.text.trim() || null })); }} />
          ) : (
            <Pressable onPress={() => setEditingTotal(true)} style={styles.totalValue} accessibilityLabel="Edit the receipt total">
              <Text style={[styles.totalAmount, !!difference && { color: colors.danger600 }]}>
                {totals?.printed_total_minor !== null && totals?.printed_total_minor !== undefined ? formatMinor(totals.printed_total_minor, currency) : 'Not read'}
              </Text>
              <Pencil size={14} color={colors.muted500} />
            </Pressable>
          )}
        </View>
        {receipt.warnings.filter((w) => !w.startsWith('The lines add up')).length > 0 && (
          <Banner tone="info" text={receipt.warnings.filter((w) => !w.startsWith('The lines add up')).join('\n')} />
        )}

        <View style={styles.aiCard} accessibilityLabel="Receipt summary">
          <View style={styles.aiTitleRow}>
            <Sparkles size={16} color={colors.primary800} />
            <Text style={styles.aiTitle}>{draft.items.length} item{draft.items.length === 1 ? '' : 's'} read{receipt.store_name ? ` from ${receipt.store_name}` : ''}</Text>
          </View>
          {discounts.length > 0 && <Text style={styles.aiLine}>{discounts.length} discount{discounts.length === 1 ? '' : 's'} applied, saving {formatMinor(savedMinor, currency)}.</Text>}
          {personal.length > 0 && (
            <Text style={styles.aiLine}>
              Just for one person: {personal.slice(0, 3).map((it) => `${it.name} (${nameOf(it.assignments[0].user_id)})`).join(', ')}{personal.length > 3 ? ` and ${personal.length - 3} more` : ''}.
            </Text>
          )}
          {unsure > 0 && <Text style={styles.aiLine}>{unsure} line{unsure === 1 ? ' was' : 's were'} hard to read; check the highlighted ones.</Text>}
          {discounts.length === 0 && personal.length === 0 && unsure === 0 && <Text style={styles.aiLine}>Everything read cleanly. Choose who each item is for below.</Text>}
          {discounts.length > 0 && (
            <View style={styles.aiTags}>
              {discounts.map((a) => <Text key={a.id} style={styles.aiTag}>{a.label} −{formatMinor(-a.amount_minor, currency)}</Text>)}
            </View>
          )}
        </View>

        <Text style={styles.peopleTitle}>WHO WAS THERE?</Text>
        <Text style={styles.peopleHint}>Tap someone who wasn’t to take them off every item.</Text>
        <View style={styles.inExpense}>
          {members.map((m) => {
            const on = inExpense(m.id);
            return (
              <Pressable key={m.id} onPress={() => toggleEverywhere(m.id)} style={[styles.person, !on && { opacity: 0.4 }]}
                accessibilityState={{ selected: on }} accessibilityLabel={`${nameOf(m.id)} in this expense`}>
                <View style={[styles.personRing, on && styles.personRingOn]}><Avatar uri={m.avatar} name={memberName(m)} size={40} /></View>
                <Text style={styles.personName} numberOfLines={1}>{nameOf(m.id).split(' ')[0]}</Text>
              </Pressable>
            );
          })}
        </View>

        {members.some((m) => !inExpense(m.id)) && (
          <Text style={styles.notThere}>Not on this bill: {members.filter((m) => !inExpense(m.id)).map((m) => nameOf(m.id)).join(', ')}</Text>
        )}

        {/* Quick assign: pick a person, then tap their items */}
        <View style={[styles.painterBox, painter && styles.painterBoxOn]}>
          <Text style={styles.painterText}>
            {painter ? `Tap items for ${nameOf(painter)} · tap again to take them off` : 'Quick assign: pick a person, then tap their items.'}
          </Text>
          <View style={styles.chips}>
            {members.filter((m) => inExpense(m.id) || painter === m.id).map((m) => {
              const on = painter === m.id;
              return (
                <Pressable key={m.id} onPress={() => setPainter(on ? null : m.id)} style={[styles.chip, on && styles.chipOn]}
                  accessibilityState={{ selected: on }} accessibilityLabel={`Assign items to ${nameOf(m.id)}`}>
                  <Avatar uri={m.avatar} name={memberName(m)} size={20} />
                  <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>{nameOf(m.id).split(' ')[0]}</Text>
                </Pressable>
              );
            })}
            {painter && (
              <Pressable onPress={() => setPainter(null)} style={styles.painterDone} accessibilityLabel="Done assigning">
                <Text style={styles.painterDoneText}>Done</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.quick}>
          <Pressable onPress={() => change((d) => ({ ...d, items: d.items.map((it) => ({ ...it, split_mode: 'equal', assignments: members.map((m) => ({ user_id: m.id, value: '1' })) })) }))} style={styles.quickButton}>
            <Text style={styles.quickText}>Everyone</Text>
          </Pressable>
          <Pressable onPress={() => change((d) => ({ ...d, items: d.items.map((it) => ({ ...it, assignments: [] })) }))} style={styles.quickButton}>
            <Text style={styles.quickText}>Clear</Text>
          </Pressable>
        </View>

        {draft.items.map((item, n) => {
          const server = receipt.items[n];
          const gross = parseMajor(item.price, currency) || 0;
          const net = server?.net_minor ?? gross;
          const voided = item.flags.includes('voided');
          const box = server?.source_box;
          const photoOfLine = box ? mediaUrl(receipt.images[box.photo]) : undefined;
          const lowConfidence = server?.confidence !== null && server?.confidence !== undefined && server.confidence < 0.6;
          const showLine = !!photoOfLine && (lineShown[n] ?? lowConfidence);
          const painted = !!painter && item.assignments.some((a) => a.user_id === painter);
          const toggle = (userId: string) => change((d) => ({
            ...d,
            items: d.items.map((it, i) => {
              if (i !== n) return it;
              const has = it.assignments.some((a) => a.user_id === userId);
              return { ...it, assignments: has ? it.assignments.filter((a) => a.user_id !== userId) : [...it.assignments, { user_id: userId, value: '1' }] };
            }),
          }));
          return (
            <View key={n} style={[styles.item, unassigned.has(n) && styles.itemMissing, painted && styles.itemPainted, voided && { opacity: 0.5 }]}>
              <Pressable onPress={() => (painter && !voided ? toggle(painter) : setEditingItem(n))} style={styles.itemTop}
                accessibilityLabel={painter ? `${painted ? 'Take' : 'Put'} ${nameOf(painter)} ${painted ? 'off' : 'on'} ${item.name}` : `Edit ${item.name}`}>
                <View style={styles.flex}>
                  <Text style={[styles.itemName, voided && { textDecorationLine: 'line-through' }]}>{item.quantity !== '1' ? `${item.quantity}× ` : ''}{item.name}</Text>
                  {item.flags.includes('reduced') && <Text style={styles.flag}>Reduced</Text>}
                  {item.category ? <Text style={styles.category}>{categoryLabel(item.category)}</Text> : null}
                  {server?.suggestion && <Text style={styles.suggestion}>{server.suggestion}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {net !== gross && <Text style={styles.strike}>{formatMinor(gross, currency)}</Text>}
                  <Text style={styles.price}>{formatMinor(net, currency)}</Text>
                  {photoOfLine && (
                    <Pressable onPress={() => setLineShown((s) => ({ ...s, [n]: !showLine }))} hitSlop={8} style={styles.lineToggle}
                      accessibilityLabel={showLine ? 'Hide the receipt line' : 'See this line on the receipt'}>
                      <ScanLine size={12} color={colors.primary700} />
                      <Text style={styles.lineToggleText}>{showLine ? 'Hide' : 'On receipt'}</Text>
                    </Pressable>
                  )}
                </View>
                <Pencil size={14} color={colors.muted400} />
              </Pressable>
              {showLine && photoOfLine && box && <ReceiptLine uri={photoOfLine} box={box} />}
              {!voided && (
                <View style={styles.chips}>
                  {members.map((m) => {
                    const on = item.assignments.some((a) => a.user_id === m.id);
                    return (
                      <Pressable key={m.id} onPress={() => toggle(m.id)} style={[styles.chip, on && styles.chipOn]} accessibilityState={{ selected: on }} accessibilityLabel={`${nameOf(m.id)} for ${item.name}`}>
                        <Avatar uri={m.avatar} name={memberName(m)} size={20} />
                        <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>{nameOf(m.id).split(' ')[0]}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        <Pressable onPress={() => setEditingItem('new')} style={styles.addButton} accessibilityLabel="Add a line">
          <Plus size={16} color={colors.primary700} />
          <Text style={styles.addText}>Add a line the scan missed</Text>
        </Pressable>

        <Text style={styles.section}>Discounts, deals, tax and fees</Text>
        {draft.adjustments.map((a, idx) => {
          if (a.item_indexes.length === 1 && DISCOUNT_KINDS.includes(a.kind) && a.source === 'printed') return null;
          const usesPercent = a.percent !== null && DISCOUNT_KINDS.includes(a.kind);
          const amount = receipt.adjustments[idx]?.amount_minor ?? parseMajor(a.amount || '', currency) ?? 0;
          const set = (patch: Partial<typeof a>) => change((d) => ({ ...d, adjustments: d.adjustments.map((x, i) => (i === idx ? { ...x, ...patch } : x)) }));
          return (
            <View key={idx} style={[styles.adjustment, !a.enabled && styles.adjustmentOff]}>
              <View style={styles.itemTop}>
                <Switch value={a.enabled} onValueChange={(enabled) => set({ enabled })} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white} />
                <Pressable onPress={() => setEditingAdjustment(idx)} style={[styles.flex, styles.itemTop]} accessibilityLabel={`Edit ${a.label}`}>
                  <View style={styles.flex}>
                    <Text style={styles.itemName}>{a.label}</Text>
                    <Text style={styles.hintText}>
                      {kindLabel(a.kind)}{a.item_indexes.length ? ` · ${a.item_indexes.length} item${a.item_indexes.length === 1 ? '' : 's'}` : ' · whole bill'}
                      {a.allocation === 'per_unit' && a.item_indexes.length > 1 ? ' · each costs the same' : ''}
                      {a.allocation === 'equal' ? ' · equally' : a.allocation === 'assign' ? ` · ${a.assignee_ids.map(nameOf).join(', ')}` : ''}
                    </Text>
                    {a.source === 'store_rule' && <Text style={styles.suggestion}>Your saved discount, not printed on the receipt</Text>}
                  </View>
                  <Text style={[styles.price, !a.enabled && { color: colors.muted400, textDecorationLine: 'line-through' }]}>{formatMinor(amount, currency)}</Text>
                  <Pencil size={14} color={colors.muted400} />
                </Pressable>
              </View>
              {usesPercent && (
                <View style={styles.presets}>
                  {PRESETS.map((p) => {
                    const active = Number((a.percent || '').replace(',', '.')) === p;
                    return (
                      <Pressable key={p} onPress={() => set({ percent: String(p), enabled: true, ...(a.source === 'printed' ? { source: 'manual' } : {}) })}
                        style={[styles.preset, active && styles.presetOn]}>
                        <Text style={[styles.presetText, active && { color: colors.white }]}>{p}%</Text>
                      </Pressable>
                    );
                  })}
                  <TextInput value={a.percent || ''} keyboardType="decimal-pad" style={styles.percent} accessibilityLabel="Discount percent"
                    onChangeText={(v) => set({ percent: v, enabled: true, ...(a.source === 'printed' ? { source: 'manual' } : {}) })} />
                  <Text style={styles.hintText}>%</Text>
                </View>
              )}
            </View>
          );
        })}

        <Pressable onPress={() => setEditingAdjustment('new')} style={styles.addButton} accessibilityLabel="Add discount, tax or fee">
          <Plus size={16} color={colors.primary700} />
          <Text style={styles.addText}>Add discount, deal, tax or fee</Text>
        </Pressable>

        <Text style={styles.section}>Paid by</Text>
        <View style={styles.people}>
          {members.map((m) => (
            <Pressable key={m.id} onPress={() => change((d) => ({ ...d, payers: [{ user_id: m.id, amount: '0' }] }))} style={[styles.personToggle, single !== m.id && styles.personOff]}>
              <View style={[styles.ring, single === m.id && styles.ringOn]}><Avatar uri={m.avatar} name={memberName(m)} size={34} /></View>
              <Text style={styles.personLabel} numberOfLines={1}>{nameOf(m.id).split(' ')[0]}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.hintText}>Several payers? Save, then edit the expense.</Text>

        {totals && (
          <View style={[styles.check, difference ? styles.checkWrong : styles.checkOk]} accessibilityLabel="Total check">
            <View style={styles.itemTop}>
              <View>
                <Text style={styles.checkLabel}>Calculated from the lines</Text>
                <Text style={styles.checkAmount}>{formatMinor(linesTotal, currency)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.checkLabel}>Receipt total</Text>
                <Text style={styles.checkAmount}>{totals.printed_total_minor === null ? 'Not entered' : formatMinor(totals.printed_total_minor, currency)}</Text>
              </View>
            </View>
            <View style={styles.checkStatus}>
              {difference ? <AlertTriangle size={16} color={colors.danger600} /> : <CheckCircle2 size={16} color={colors.success700} />}
              <Text style={[styles.checkText, { color: difference ? colors.danger600 : colors.success700 }]}>
                {difference
                  ? `Off by ${formatMinor(Math.abs(difference), currency)}. Check a price, a discount or the receipt total.`
                  : totals.printed_total_minor === null ? 'Enter the receipt total above to double-check.' : 'Matches the receipt total'}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.summary}>
          <View style={styles.itemTop}>
            <Text style={styles.section}>Each person pays</Text>
            {syncing && <ActivityIndicator size="small" color={colors.primary700} />}
          </View>
          {totals?.people.map((p) => (
            <View key={p.user_id} style={styles.itemTop}>
              <Text style={styles.summaryName}>{nameOf(p.user_id)}</Text>
              <Text style={styles.summaryAmount}>{formatMinor(p.amount_minor, currency)}</Text>
            </View>
          ))}
          {!!totals?.unassigned_minor && (
            <View style={styles.itemTop}>
              <Text style={[styles.summaryName, { color: colors.danger600 }]}>Not assigned yet</Text>
              <Text style={[styles.summaryAmount, { color: colors.danger600 }]}>{formatMinor(totals.unassigned_minor, currency)}</Text>
            </View>
          )}
        </View>
      </ScrollView>
      {editingItem !== null && (
        <ItemEditor
          isNew={editingItem === 'new'}
          item={editingItem === 'new'
            ? { id: null, name: '', quantity: '1', unit: 'each', price: '', category: null, flags: [], split_mode: 'equal', assignments: members.map((m) => ({ user_id: m.id, value: '1' })) }
            : draft.items[editingItem]}
          discount={editingItem === 'new' ? '' : (() => {
            const total = lineDiscounts(draft, editingItem).reduce((sum, a) => sum + Math.abs(Number(a.amount) || 0), 0);
            return total ? total.toFixed(2) : '';
          })()}
          members={members}
          nameOf={nameOf}
          onSave={(item, saved) => { saveItem(editingItem, item, saved); setEditingItem(null); }}
          onRemove={() => { if (editingItem !== 'new') removeItem(editingItem); setEditingItem(null); }}
          onClose={() => setEditingItem(null)}
        />
      )}
      {editingAdjustment !== null && (
        <AdjustmentEditor
          isNew={editingAdjustment === 'new'}
          adjustment={editingAdjustment === 'new'
            ? { kind: 'store_discount', label: 'Discount', amount: '', percent: null, item_indexes: [], allocation: 'proportional', assignee_ids: [], source: 'printed', enabled: true }
            : draft.adjustments[editingAdjustment]}
          items={draft.items}
          members={members}
          nameOf={nameOf}
          onSave={(a) => { saveAdjustment(editingAdjustment, a); setEditingAdjustment(null); }}
          onRemove={() => { if (editingAdjustment !== 'new') change((d) => ({ ...d, adjustments: d.adjustments.filter((_, i) => i !== editingAdjustment) })); setEditingAdjustment(null); }}
          onClose={() => setEditingAdjustment(null)}
        />
      )}
      <CurrencyPicker visible={pickingCurrency} value={currency} onClose={() => setPickingCurrency(false)}
        onPick={(code) => { setPickingCurrency(false); change((d) => ({ ...d, currency: code })); }} />
      <View style={styles.footer}>
        {blocking && <Text style={styles.blocking}>{blocking}</Text>}
        <Button title={`Save expense${totals ? ` · ${formatMinor(totals.computed_total_minor, currency)}` : ''}`} onPress={save} loading={saving} disabled={!!blocking} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  note: {
    marginTop: space(4), minHeight: 72, padding: space(3), borderWidth: 1, borderColor: colors.muted200, borderRadius: 12,
    backgroundColor: colors.white, color: colors.muted900, fontSize: 15, textAlignVertical: 'top',
  },
  flex: { flex: 1 },
  content: { padding: space(4), paddingBottom: space(10), backgroundColor: colors.background, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8), backgroundColor: colors.white },
  lead: { fontSize: 15, color: colors.muted700, marginBottom: space(4) },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(4) },
  thumb: { width: 100, height: 130, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.muted100 },
  thumbImage: { width: '100%', height: '100%' },
  remove: { position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  pickRow: { flexDirection: 'row', gap: space(2) },
  waitTitle: { marginTop: space(4), fontSize: 17, fontWeight: '600', color: colors.muted900, textAlign: 'center' },
  waitText: { marginTop: space(1), fontSize: 14, color: colors.muted500, textAlign: 'center' },
  steps: { marginTop: space(5), gap: space(2), alignSelf: 'stretch', maxWidth: 320, marginHorizontal: 'auto' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  stepText: { fontSize: 14, fontWeight: '600', color: colors.muted900 },
  stepDone: { fontWeight: '400', color: colors.muted500 },
  store: { flex: 1, fontSize: 20, fontWeight: '700', color: colors.muted900 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space(2), marginBottom: space(2) },
  currency: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.full, borderWidth: 1, borderColor: colors.primary200, backgroundColor: colors.primary50 },
  currencyText: { fontSize: 14, fontWeight: '700', color: colors.primary800 },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space(3), paddingVertical: space(2), marginBottom: space(3), borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200 },
  totalRowWrong: { borderColor: colors.danger500, backgroundColor: colors.danger50 },
  totalLabel: { fontSize: 14, color: colors.muted600 },
  totalValue: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  totalAmount: { fontSize: 16, fontWeight: '700', color: colors.muted900 },
  totalInput: { minWidth: 90, height: 36, borderWidth: 1, borderColor: colors.primary500, borderRadius: radius.sm, paddingHorizontal: space(2), textAlign: 'right', fontSize: 16, color: colors.muted900 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5), marginTop: space(2) },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 2, paddingRight: space(2), paddingVertical: 2, borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  chipOn: { borderColor: colors.primary600, backgroundColor: colors.primary50 },
  chipText: { fontSize: 12, color: colors.muted500, maxWidth: 80 },
  chipTextOn: { color: colors.primary800, fontWeight: '600' },
  quick: { flexDirection: 'row', gap: space(2), marginBottom: space(3) },
  quickButton: { paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.full, backgroundColor: colors.muted100 },
  quickText: { fontSize: 13, color: colors.muted700 },
  item: { backgroundColor: colors.white, borderRadius: 14, borderWidth: 1, borderColor: colors.muted200, paddingHorizontal: space(3), paddingVertical: space(2.5), marginBottom: space(1.5) },
  itemMissing: { borderColor: colors.danger500, backgroundColor: colors.danger50 },
  itemPainted: { borderColor: colors.primary500, borderWidth: 2 },
  category: { alignSelf: 'flex-start', marginTop: 2, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.muted100, fontSize: 11, color: colors.muted600 },
  lineToggle: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  lineToggleText: { fontSize: 11, fontWeight: '600', color: colors.primary700 },
  peopleHint: { fontSize: 12, color: colors.muted500, marginBottom: space(2) },
  notThere: { fontSize: 12, color: colors.muted600, marginTop: -space(1), marginBottom: space(2) },
  painterBox: { borderWidth: 1, borderColor: colors.muted200, borderRadius: 14, padding: space(3), marginBottom: space(2) },
  painterBoxOn: { borderColor: colors.primary300, backgroundColor: colors.primary50 },
  painterText: { fontSize: 13, color: colors.muted700 },
  painterDone: { paddingHorizontal: space(3), paddingVertical: 4, borderRadius: radius.full, backgroundColor: colors.primary600, justifyContent: 'center' },
  painterDoneText: { fontSize: 12, fontWeight: '700', color: colors.white },
  itemTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(2) },
  itemName: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  flag: { alignSelf: 'flex-start', marginTop: 2, fontSize: 11, color: colors.warning700, backgroundColor: colors.warning50, paddingHorizontal: 6, borderRadius: 4, overflow: 'hidden' },
  suggestion: { fontSize: 12, color: colors.primary700, marginTop: 2 },
  strike: { fontSize: 12, color: colors.muted400, textDecorationLine: 'line-through' },
  price: { fontSize: 15, fontWeight: '700', color: colors.muted900 },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3), marginTop: space(2.5) },
  personToggle: { alignItems: 'center', width: 52 },
  personOff: { opacity: 0.35 },
  ring: { padding: 2, borderRadius: 20, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: colors.primary600 },
  personLabel: { fontSize: 11, color: colors.muted600, marginTop: 2, maxWidth: 52 },
  section: { fontSize: 15, fontWeight: '700', color: colors.muted900, marginTop: space(4), marginBottom: space(2) },
  adjustment: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.muted200, padding: space(3), marginBottom: space(2) },
  adjustmentOff: { borderStyle: 'dashed', backgroundColor: colors.muted50 },
  presets: { flexDirection: 'row', alignItems: 'center', gap: space(2), marginTop: space(2.5) },
  preset: { paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.sm, borderWidth: 1, borderColor: colors.muted300 },
  presetOn: { backgroundColor: colors.primary700, borderColor: colors.primary700 },
  presetText: { fontSize: 13, color: colors.muted700, fontWeight: '600' },
  percent: { width: 56, height: 36, borderWidth: 1, borderColor: colors.muted300, borderRadius: radius.sm, textAlign: 'right', paddingHorizontal: space(2), color: colors.muted900 },
  hintText: { fontSize: 12, color: colors.muted500 },
  addButton: { flexDirection: 'row', alignItems: 'center', gap: space(1.5), alignSelf: 'flex-start', paddingVertical: space(2), paddingHorizontal: space(1) },
  addText: { fontSize: 14, fontWeight: '600', color: colors.primary700 },
  aiCard: { padding: space(4), borderRadius: 16, backgroundColor: colors.primary50, borderWidth: 1, borderColor: colors.primary100, marginBottom: space(4), gap: space(1.5) },
  aiTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  aiTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.primary800 },
  aiLine: { fontSize: 14, lineHeight: 20, color: colors.muted900 },
  aiTags: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5), marginTop: space(1) },
  aiTag: { paddingHorizontal: space(2), paddingVertical: space(1), borderRadius: 8, backgroundColor: colors.white, color: colors.success700, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
  peopleTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: colors.muted500, marginBottom: space(2) },
  inExpense: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3), marginBottom: space(4) },
  person: { alignItems: 'center', width: 56, gap: 4 },
  personRing: { borderRadius: 24, padding: 2, borderWidth: 2, borderColor: 'transparent' },
  personRingOn: { borderColor: colors.primary500 },
  personName: { fontSize: 11, color: colors.muted600 },
  check: { marginTop: space(4), padding: space(4), borderRadius: 16, borderWidth: 1, gap: space(3) },
  checkOk: { backgroundColor: colors.success50, borderColor: '#bbf7d0' },
  checkWrong: { backgroundColor: colors.danger50, borderColor: '#ecc6cc' },
  checkLabel: { fontSize: 12, color: colors.muted500 },
  checkAmount: { marginTop: 2, fontSize: 18, fontWeight: '700', color: colors.muted900 },
  checkStatus: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2) },
  checkText: { flex: 1, fontSize: 14, fontWeight: '600' },
  summary: { marginTop: space(4), padding: space(4), borderRadius: radius.lg, backgroundColor: colors.white, gap: space(2) },
  summaryName: { fontSize: 15, color: colors.muted700 },
  summaryAmount: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  footer: { padding: space(4), paddingBottom: space(6), backgroundColor: colors.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200, gap: space(2) },
  blocking: { fontSize: 13, color: colors.danger600, textAlign: 'center' },
});

export default ScanReceiptScreen;
