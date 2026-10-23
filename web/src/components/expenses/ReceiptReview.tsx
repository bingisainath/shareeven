// src/components/expenses/ReceiptReview.tsx
// Review what the AI read: fix lines, choose who each item is for, switch discounts on/off,
// say who paid. Every change is saved and the split recalculated on the server (exact cents).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { AlertTriangle, CheckCircle2, Plus, ScanLine, Sparkles, Tag, Trash2 } from 'lucide-react';
import { CATEGORIES, expenseService } from '../../services/expense.service';
import CategoryIcon from './CategoryIcon';
import ReceiptLine from './ReceiptLine';
import { RECEIPT_CATEGORIES, categoryLabel } from '../../utils/receiptCategories';
import type { Expense, Receipt, ReceiptAdjustment, ReceiptUpdate } from '../../services/expense.service';
import { parseApiError } from '../../utils/apiError';
import { resolveMediaUrl } from '../../utils/media';
import MediaViewer from '../organisms/MediaViewer';
import { formatMinor, parseMajor, toMajorString } from '../../utils/money';
import { CurrencySelect, displayName, firstName, Money, MoneyInput, PersonToggle, Switch } from './shared';
import type { Member } from './shared';
import { PayersEditor } from './ManualExpenseForm';
import type { PayerDraft } from './ManualExpenseForm';
import { confirmDialog } from '../organisms/ConfirmDialog';

type Draft = ReceiptUpdate;
type ItemDraft = Draft['items'][number];
type AdjustmentDraft = Draft['adjustments'][number];

const KIND_LABELS: Record<string, string> = {
  item_discount: 'Item discount',
  promotion: 'Promotion',
  store_discount: 'Store discount',
  coupon: 'Coupon',
  tax: 'Tax',
  service_charge: 'Service charge',
  tip: 'Tip',
  fee: 'Fee',
  rounding: 'Rounding',
};
const DISCOUNT_KINDS = ['item_discount', 'promotion', 'store_discount', 'coupon'];
const PERCENT_PRESETS = [10, 15, 20];
const FLAG_LABELS: Record<string, string> = { reduced: 'Reduced', deposit: 'Deposit', bag: 'Bag', weighed: 'Weighed', voided: 'Voided', alcohol: 'Alcohol' };

function toDraft(receipt: Receipt): Draft {
  const currency = receipt.currency || 'EUR';
  return {
    store_name: receipt.store_name,
    currency,
    printed_total: receipt.printed_total_minor === null ? null : toMajorString(receipt.printed_total_minor, currency),
    items: receipt.items.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      price: toMajorString(i.gross_minor, currency),
      category: i.category,
      flags: i.flags,
      split_mode: i.split_mode,
      assignments: i.assignments,
    })),
    adjustments: receipt.adjustments.map((a) => ({
      kind: a.kind,
      label: a.label,
      amount: toMajorString(a.amount_minor, currency),
      percent: a.percent,
      item_indexes: a.item_indexes,
      allocation: a.allocation,
      assignee_ids: a.assignee_ids,
      source: a.source,
      enabled: a.enabled,
    })),
    payers: receipt.payers.length > 1
      ? receipt.payers.map((p) => ({ user_id: p.user_id, amount: toMajorString(p.amount_minor, currency) }))
      : receipt.payers.length === 1 ? [{ user_id: receipt.payers[0].user_id, amount: '0' }] : null,
  };
}

interface Props {
  receipt: Receipt;
  members: Member[];
  currentUserId: string;
  onSaved: (expense: Expense) => void;
  onDiscard: () => void;
}

const ReceiptReview: React.FC<Props> = ({ receipt: initial, members, currentUserId, onSaved, onDiscard }) => {
  const [server, setServer] = useState<Receipt>(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [expanded, setExpanded] = useState<number | null>(null);
  const [lineShown, setLineShown] = useState<Record<number, boolean>>({}); // the printed line under an item
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [description, setDescription] = useState(initial.store_name || '');
  const [several, setSeveral] = useState<PayerDraft[] | null>(() =>
    initial.payers.length > 1
      ? initial.payers.map((p) => ({ user_id: p.user_id, amount: toMajorString(p.amount_minor, initial.currency || 'EUR') }))
      : null);
  const [category, setCategory] = useState('groceries');

  const currency = draft.currency;
  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const nameOf = (id: string) => (id === currentUserId ? 'You' : firstName(memberById[id]));

  // ---- autosave: debounce edits, keep the newest request's answer
  const pending = useRef<Promise<void> | null>(null);
  const requestNo = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  latest.current = draft;

  const push = useCallback(async () => {
    const mine = ++requestNo.current;
    setSyncing(true);
    try {
      const updated = await expenseService.updateReceipt(initial.id, latest.current);
      if (mine === requestNo.current) {
        setServer(updated);
        // Item ids change on every save; keep ours in step so the AI's notes stay attached
        setDraft((d) => d.items.length === updated.items.length
          ? { ...d, items: d.items.map((item, n) => ({ ...item, id: updated.items[n].id })) }
          : d);
      }
    } catch (error) {
      if (mine === requestNo.current) toast.error(parseApiError(error));
    } finally {
      if (mine === requestNo.current) setSyncing(false);
    }
  }, [initial.id]);

  const change = (update: (d: Draft) => Draft) => {
    setDraft((d) => update(d));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { pending.current = push(); }, 450);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flush = async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      pending.current = push();
    }
    await pending.current;
  };

  // ---- helpers
  const setItem = (n: number, patch: Partial<ItemDraft>) =>
    change((d) => ({ ...d, items: d.items.map((it, i) => (i === n ? { ...it, ...patch } : it)) }));
  const setAdjustment = (n: number, patch: Partial<AdjustmentDraft>) =>
    change((d) => ({ ...d, adjustments: d.adjustments.map((a, i) => (i === n ? { ...a, ...patch } : a)) }));

  const togglePerson = (n: number, userId: string) => {
    const item = draft.items[n];
    const has = item.assignments.some((a) => a.user_id === userId);
    setItem(n, {
      assignments: has ? item.assignments.filter((a) => a.user_id !== userId) : [...item.assignments, { user_id: userId, value: '1' }],
    });
  };
  const setUnits = (n: number, userId: string, delta: number) => {
    const item = draft.items[n];
    setItem(n, {
      assignments: item.assignments
        .map((a) => (a.user_id === userId ? { ...a, value: String(Math.max(0, (Number(a.value) || 0) + delta)) } : a))
        .filter((a) => Number(a.value) > 0),
    });
  };
  const assignAll = (userIds: string[]) =>
    change((d) => ({
      ...d,
      items: d.items.map((it) => ({ ...it, split_mode: 'equal', assignments: userIds.map((u) => ({ user_id: u, value: '1' })) })),
    }));

  const removeItem = (n: number) =>
    change((d) => ({
      ...d,
      items: d.items.filter((_, i) => i !== n),
      // Re-point discounts at the remaining lines; drop ones that only belonged to this line
      adjustments: d.adjustments.flatMap((a) => {
        if (!a.item_indexes.length) return [a];
        const indexes = a.item_indexes.filter((i) => i !== n).map((i) => (i > n ? i - 1 : i));
        return indexes.length ? [{ ...a, item_indexes: indexes }] : [];
      }),
    }));

  const addItem = () => {
    change((d) => ({
      ...d,
      items: [...d.items, {
        id: null, name: 'New item', quantity: '1', unit: 'each', price: '', category: null, flags: [],
        split_mode: 'equal', assignments: members.map((m) => ({ user_id: m.id, value: '1' })),
      }],
    }));
    setExpanded(draft.items.length);
  };

  const addAdjustment = (kind: string) =>
    change((d) => ({
      ...d,
      adjustments: [...d.adjustments, {
        kind, label: KIND_LABELS[kind], amount: '', percent: kind === 'store_discount' ? '10' : null, item_indexes: [],
        allocation: kind === 'tip' || kind === 'service_charge' || kind === 'fee' ? 'equal' : 'proportional',
        assignee_ids: [], source: kind === 'tip' ? 'manual' : 'printed', enabled: true,
      }],
    }));

  // ---- derived from the server's last calculation
  const totals = server.totals;
  const unassigned = new Set(totals?.unassigned_item_indexes || []);
  const itemAdjustments = (n: number) =>
    draft.adjustments
      .map((a, idx) => ({ a, idx }))
      .filter(({ a }) => a.enabled && a.item_indexes.length === 1 && a.item_indexes[0] === n && DISCOUNT_KINDS.includes(a.kind));
  const billAdjustments = draft.adjustments
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => !(a.item_indexes.length === 1 && DISCOUNT_KINDS.includes(a.kind) && a.source === 'printed'));

  // "Several" is its own mode: it may start with just one person ticked while amounts are typed in
  const singlePayer = !several && draft.payers?.length === 1 ? draft.payers[0].user_id : server.uploaded_by || currentUserId;
  const paidMinor = (several || []).reduce((sum, p) => sum + (parseMajor(p.amount, currency) || 0), 0);
  const payersProblem = several && totals && paidMinor !== totals.computed_total_minor
    ? `What people paid must add up to ${formatMinor(totals.computed_total_minor, currency)}`
    : null;

  // ---- what the summary card and the people row show
  const discountsApplied = server.adjustments.filter((a) => a.enabled && DISCOUNT_KINDS.includes(a.kind) && a.amount_minor < 0);
  const savedMinor = -discountsApplied.reduce((sum, a) => sum + a.amount_minor, 0);
  const personalItems = draft.items
    .map((item, n) => ({ item, n }))
    .filter(({ item }) => !item.flags.includes('voided') && item.assignments.length === 1 && members.length > 1);
  const unsureCount = server.items.filter((i) => i.confidence !== null && i.confidence !== undefined && i.confidence < 0.6).length;
  const inExpense = (userId: string) => draft.items.some((it) => it.assignments.some((a) => a.user_id === userId));
  const toggleEverywhere = (userId: string) =>
    change((d) => ({
      ...d,
      items: d.items.map((it) => {
        const has = it.assignments.some((a) => a.user_id === userId);
        if (inExpense(userId)) return has ? { ...it, assignments: it.assignments.filter((a) => a.user_id !== userId) } : it;
        return has ? it : { ...it, assignments: [...it.assignments, { user_id: userId, value: '1' }] };
      }),
    }));
  const linesMinor = (totals?.computed_total_minor || 0) - (totals?.outside_receipt_minor || 0);

  const save = async () => {
    setSaving(true);
    try {
      await flush();
      const expense = await expenseService.saveReceipt(initial.id, { description: description.trim() || undefined, category });
      toast.success('Expense saved');
      onSaved(expense);
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (!(await confirmDialog({ title: 'Discard this receipt?', message: 'The photo and everything read from it will be removed.', confirmText: 'Discard', danger: true }))) return;
    try {
      await expenseService.discardReceipt(initial.id);
      onDiscard();
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };

  const difference = totals?.difference_minor ?? null;
  const blocking = server.calc_error
    || (totals && totals.unassigned_item_indexes.length > 0
      ? `Choose who ${totals.unassigned_item_indexes.length === 1 ? 'the highlighted item is' : 'the highlighted items are'} for`
      : null)
    || (difference
      ? `The items add up to ${formatMinor((totals?.computed_total_minor || 0) - (totals?.outside_receipt_minor || 0), currency)}, but the receipt total is ${formatMinor(totals?.printed_total_minor, currency)}. Fix a price, a discount or the receipt total.`
      : null)
    || payersProblem;

  return (
    <div className="space-y-5 pb-2">
      {/* Store, total, photos */}
      <div className="flex gap-3.5">
        <div className="flex -space-x-3 flex-shrink-0">
          {server.images.map((src) => (
            <button key={src} type="button" onClick={() => setPhoto(src)} title="See the photo" className="w-14 h-[68px] rounded-xl overflow-hidden border-2 border-white shadow-card">
              <img src={resolveMediaUrl(src)} alt="Receipt" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={draft.store_name || 'Receipt'}
            aria-label="Description"
            className="w-full px-2 py-1 -ml-2 font-display text-lg font-semibold text-muted-900 rounded-lg border border-transparent hover:border-muted-200 focus:border-primary-400 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-600">
            <CurrencySelect value={currency} onChange={(c) => change((d) => ({ ...d, currency: c }))} className="py-1" />
            <span>Receipt total</span>
            <MoneyInput
              value={draft.printed_total || ''}
              currency={currency}
              ariaLabel="Total on the receipt"
              className="w-24 py-1"
              onChange={(v) => change((d) => ({ ...d, printed_total: v }))}
            />
          </div>
        </div>
      </div>

      {/* What was read, in a few lines */}
      <section className="p-4 rounded-2xl bg-primary-50 border border-primary-100" aria-label="Receipt summary">
        <p className="flex items-center gap-2 text-sm font-bold text-primary-800">
          <Sparkles size={16} /> {draft.items.length} item{draft.items.length === 1 ? '' : 's'} read{draft.store_name ? ` from ${draft.store_name}` : ''}
          {server.model && <span className="font-normal text-xs text-primary-600">· {server.model}{server.key_source === 'user' ? ', your key' : ''}</span>}
        </p>
        <ul className="mt-2 space-y-1 text-sm text-primary-900">
          {discountsApplied.length > 0 && (
            <li>{discountsApplied.length} discount{discountsApplied.length === 1 ? '' : 's'} applied, saving <b><Money minor={savedMinor} currency={currency} /></b>.</li>
          )}
          {personalItems.length > 0 && (
            <li>
              Just for one person: {personalItems.slice(0, 3).map(({ item }) => `${item.name} (${nameOf(item.assignments[0].user_id)})`).join(', ')}
              {personalItems.length > 3 ? ` and ${personalItems.length - 3} more` : ''}.
            </li>
          )}
          {unsureCount > 0 && <li>{unsureCount} line{unsureCount === 1 ? ' was' : 's were'} hard to read; check the highlighted ones.</li>}
          {discountsApplied.length === 0 && personalItems.length === 0 && unsureCount === 0 && <li>Everything read cleanly. Choose who each item is for below.</li>}
        </ul>
        {discountsApplied.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {discountsApplied.map((a) => (
              <span key={a.id ?? `${a.label}-${a.amount_minor}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white text-xs font-semibold text-success-700 border border-success-100">
                <Tag size={12} /> {a.label} −<Money minor={-a.amount_minor} currency={currency} />
              </span>
            ))}
          </div>
        )}
      </section>

      {server.warnings.filter((w) => !w.startsWith('The lines add up')).length > 0 && (
        <div className="p-3 rounded-xl bg-warning-50 border border-warning-200 text-sm text-warning-800 space-y-1">
          {server.warnings.filter((w) => !w.startsWith('The lines add up')).map((w) => <p key={w}>{w}</p>)}
        </div>
      )}

      {/* Who was there: tap someone who wasn't to take them off every item (tap again to add them back) */}
      <div role="group" aria-label="Who was there">
        <h3 className="mb-1 text-xs font-bold uppercase tracking-[0.1em] text-muted-500">Who was there?</h3>
        <p className="mb-2 text-xs text-muted-500">Tap someone who wasn’t to take them off every item.</p>
        <div className="flex flex-wrap gap-3">
          {members.map((m) => (
            <PersonToggle key={m.id} member={m} selected={inExpense(m.id)} onToggle={() => toggleEverywhere(m.id)} label={nameOf(m.id)} />
          ))}
        </div>
        {members.some((m) => !inExpense(m.id)) && (
          <p className="mt-2 text-xs text-muted-600">
            Not on this bill: {members.filter((m) => !inExpense(m.id)).map((m) => nameOf(m.id)).join(', ')}
          </p>
        )}
      </div>

      {/* Quick assign */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-muted-900">Who is each item for?</h3>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => assignAll(members.map((m) => m.id))} className="px-3 py-1.5 text-xs font-semibold rounded-full border border-muted-200 text-muted-600 hover:bg-muted-50">Everyone</button>
          <button type="button" onClick={() => assignAll([])} className="px-3 py-1.5 text-xs font-semibold rounded-full border border-muted-200 text-muted-600 hover:bg-muted-50">Clear</button>
        </div>
      </div>

      {/* Items */}
      <ul className="space-y-2">
        {draft.items.map((item, n) => {
          const serverItem = server.items[n];
          const gross = parseMajor(item.price, currency) || 0;
          const net = serverItem?.net_minor ?? gross;
          const voided = item.flags.includes('voided');
          const lowConfidence = serverItem?.confidence !== null && serverItem?.confidence !== undefined && serverItem.confidence < 0.6;
          const byQuantity = item.split_mode !== 'equal';
          const box = serverItem?.source_box;
          const photoOfLine = box ? server.images[box.photo] : undefined;
          const showLine = !!photoOfLine && (lineShown[n] ?? lowConfidence);
          return (
            <li
              key={n}
              className={`p-3.5 rounded-[14px] border ${unassigned.has(n) ? 'border-accent-400 bg-accent-50/40' : lowConfidence ? 'border-warning-300 bg-warning-50/40' : expanded === n ? 'border-primary-300 bg-white shadow-card' : 'border-muted-200 bg-white'} ${voided ? 'opacity-50' : ''}`}
            >
              <div className="flex items-start gap-2">
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setExpanded(expanded === n ? null : n)} aria-expanded={expanded === n} title="Edit this line">
                  <p className={`font-medium text-muted-900 truncate ${voided ? 'line-through' : ''}`}>
                    {item.quantity !== '1' && <span className="text-muted-500">{item.quantity}{item.unit !== 'each' ? item.unit : '×'} </span>}
                    {item.name}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {item.flags.map((f) => (
                      <span key={f} className="px-1.5 py-0.5 text-[10px] rounded bg-warning-100 text-warning-800">{FLAG_LABELS[f] || f}</span>
                    ))}
                    {itemAdjustments(n).map(({ a, idx }) => (
                      <span key={idx} className="px-1.5 py-0.5 text-[10px] rounded bg-success-100 text-success-800">{a.label} {a.amount}</span>
                    ))}
                    {item.category && <span className="px-1.5 py-0.5 text-[10px] rounded bg-muted-100 text-muted-600">{categoryLabel(item.category)}</span>}
                    {serverItem?.suggestion && <span className="text-[10px] text-primary-600">{serverItem.suggestion}</span>}
                  </div>
                </button>
                <div className="text-right flex-shrink-0">
                  {net !== gross && <Money minor={gross} currency={currency} className="block text-xs text-muted-400 line-through" />}
                  <Money minor={net} currency={currency} className="font-bold text-muted-900" />
                  {photoOfLine && (
                    <button type="button" onClick={() => setLineShown((s) => ({ ...s, [n]: !showLine }))} aria-expanded={showLine}
                      className="mt-0.5 ml-auto flex items-center gap-1 text-[11px] font-medium text-primary-700 hover:underline">
                      <ScanLine size={12} /> {showLine ? 'Hide' : 'On receipt'}
                    </button>
                  )}
                </div>
              </div>
              {showLine && photoOfLine && box && <ReceiptLine src={resolveMediaUrl(photoOfLine) || photoOfLine} box={box} className="mt-2" />}

              {/* Who is this for? */}
              {!voided && (
                <div className="flex flex-wrap items-end gap-2.5 mt-2">
                  {members.map((m) => {
                    const assignment = item.assignments.find((a) => a.user_id === m.id);
                    return (
                      <div key={m.id} className="flex flex-col items-center gap-1">
                        <PersonToggle member={m} selected={!!assignment} onToggle={() => togglePerson(n, m.id)} size="xs" label={nameOf(m.id)} />
                        {byQuantity && assignment && (
                          <div className="flex items-center text-xs">
                            <button type="button" aria-label={`One less for ${nameOf(m.id)}`} onClick={() => setUnits(n, m.id, -1)} className="w-5 h-5 rounded bg-muted-100">−</button>
                            <span className="w-5 text-center tabular-nums">{assignment.value}</span>
                            <button type="button" aria-label={`One more for ${nameOf(m.id)}`} onClick={() => setUnits(n, m.id, 1)} className="w-5 h-5 rounded bg-muted-100">+</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setItem(n, { split_mode: byQuantity ? 'equal' : 'quantity' })}
                    className="ml-auto px-2 py-1 text-[11px] rounded-md text-primary-700 hover:bg-primary-50"
                  >
                    {byQuantity ? 'Split equally' : 'Split by quantity'}
                  </button>
                </div>
              )}

              {/* Edit the line */}
              {expanded === n && (
                <div className="mt-3 pt-3 border-t border-muted-100 grid grid-cols-2 gap-2 text-sm">
                  <input value={item.name} onChange={(e) => setItem(n, { name: e.target.value })} aria-label="Item name" className="col-span-2 px-2 py-1.5 rounded-lg border border-muted-300" />
                  <label className="flex items-center gap-2">Qty
                    <input value={item.quantity} inputMode="decimal" onChange={(e) => setItem(n, { quantity: e.target.value })} className="w-16 px-2 py-1.5 rounded-lg border border-muted-300 text-right" />
                  </label>
                  <label className="flex items-center gap-2 justify-end">Price
                    <MoneyInput value={item.price} currency={currency} onChange={(price) => setItem(n, { price })} className="w-24 py-1.5" ariaLabel="Line price" />
                  </label>
                  <label className="col-span-2 flex items-center gap-2">Category
                    <select value={item.category || ''} onChange={(e) => setItem(n, { category: e.target.value || null })}
                      className="flex-1 px-2 py-1.5 rounded-lg border border-muted-300 bg-white">
                      <option value="">None</option>
                      {RECEIPT_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  </label>
                  <div className="col-span-2 flex flex-wrap gap-1.5">
                    {Object.entries(FLAG_LABELS).map(([flag, label]) => (
                      <button
                        key={flag}
                        type="button"
                        onClick={() => setItem(n, { flags: item.flags.includes(flag) ? item.flags.filter((f) => f !== flag) : [...item.flags, flag] })}
                        className={`px-2 py-0.5 text-xs rounded-full border ${item.flags.includes(flag) ? 'border-warning-400 bg-warning-50' : 'border-muted-200 text-muted-500'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {serverItem?.raw_text && <p className="col-span-2 text-xs text-muted-400 font-mono truncate">Printed: {serverItem.raw_text}</p>}
                  <button type="button" onClick={() => { removeItem(n); setExpanded(null); }} className="col-span-2 justify-self-start inline-flex items-center gap-1 text-xs font-semibold text-accent-600 hover:underline">
                    <Trash2 size={13} /> Remove this line
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={addItem} className="w-full h-11 rounded-[14px] border border-dashed border-primary-300 text-sm font-semibold text-primary-700 hover:bg-primary-50 inline-flex items-center justify-center gap-1.5">
        <Plus size={16} /> Add a line
      </button>

      {/* Discounts, tax, fees */}
      <section className="space-y-2">
        <h3 className="font-display font-semibold text-muted-900">Promotions, discounts, tax and fees</h3>
        {billAdjustments.length === 0 && <p className="text-sm text-muted-500">Nothing else on this receipt.</p>}
        {billAdjustments.map(({ a, idx }) => (
          <AdjustmentRow
            key={idx}
            adjustment={a}
            serverAdjustment={server.adjustments[idx]}
            currency={currency}
            members={members}
            itemCount={draft.items.length}
            nameOf={nameOf}
            onChange={(patch) => setAdjustment(idx, patch)}
            onRemove={() => change((d) => ({ ...d, adjustments: d.adjustments.filter((_, i) => i !== idx) }))}
          />
        ))}
        <div className="flex flex-wrap gap-1.5">
          {['coupon', 'store_discount', 'tip', 'service_charge', 'fee', 'tax'].map((kind) => (
            <button key={kind} type="button" onClick={() => addAdjustment(kind)} className="px-2.5 py-1 text-xs rounded-full border border-muted-200 text-muted-600 hover:bg-muted-50">
              + {KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </section>

      {/* Who paid */}
      <PayersEditor
        members={members}
        currentUserId={currentUserId}
        currency={currency}
        totalMinor={totals?.computed_total_minor ?? null}
        value={several}
        singlePayer={singlePayer}
        onChange={(value, single) => {
          setSeveral(value);
          change((d) => ({ ...d, payers: value ?? [{ user_id: single, amount: '0' }] }));
        }}
      />

      <div className="flex flex-wrap gap-2">
        {CATEGORIES.slice(0, 6).map((c) => (
          <button key={c.id} type="button" onClick={() => setCategory(c.id)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm border ${category === c.id ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-muted-200 text-muted-600'}`}>
            <CategoryIcon category={c.id} bare /> {c.label}
          </button>
        ))}
      </div>

      {/* Does what we worked out match the receipt? */}
      {totals && (
        <section
          aria-label="Total check"
          className={`p-4 rounded-2xl border ${difference ? 'bg-accent-50 border-accent-200' : 'bg-success-50 border-success-200'}`}
        >
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-500">Calculated from the lines</p>
              <Money minor={linesMinor} currency={currency} className="text-lg font-bold text-muted-900" />
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-500">Receipt total</p>
              {totals.printed_total_minor === null
                ? <span className="text-sm text-muted-500">Not entered</span>
                : <Money minor={totals.printed_total_minor} currency={currency} className="text-lg font-bold text-muted-900" />}
            </div>
          </div>
          <p className={`mt-3 flex items-start gap-2 text-sm font-semibold ${difference ? 'text-accent-700' : 'text-success-700'}`}>
            {difference
              ? <><AlertTriangle size={17} className="flex-shrink-0" /> <span>Off by <Money minor={Math.abs(difference)} currency={currency} />. Check a price, a discount or the receipt total.</span></>
              : totals.printed_total_minor === null
                ? <><CheckCircle2 size={17} /> Enter the receipt total above to double-check.</>
                : <><CheckCircle2 size={17} /> Matches the receipt total</>}
          </p>
          {!!totals.outside_receipt_minor && (
            <p className="mt-1 text-xs text-muted-500">Plus <Money minor={totals.outside_receipt_minor} currency={currency} /> you added that isn’t on the receipt (e.g. a tip).</p>
          )}
        </section>
      )}

      {/* Summary */}
      <section className="p-4 rounded-2xl bg-[#f6f4fa] space-y-1.5">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-semibold text-muted-900">Each person pays</h3>
          {syncing && <span className="text-xs text-muted-400">Updating…</span>}
        </div>
        {totals?.people.map((p) => (
          <div key={p.user_id} className="flex items-center justify-between text-sm">
            <span className="text-muted-700">{p.user_id === currentUserId ? 'You' : displayName(memberById[p.user_id])}</span>
            <Money minor={p.amount_minor} currency={currency} className="font-medium" />
          </div>
        ))}
        {!!totals?.unassigned_minor && (
          <div className="flex items-center justify-between text-sm text-accent-600">
            <span>Not assigned yet</span>
            <Money minor={totals.unassigned_minor} currency={currency} />
          </div>
        )}
        <div className="flex items-center justify-between pt-1.5 border-t border-muted-200 font-semibold">
          <span>Total</span>
          <Money minor={totals?.computed_total_minor} currency={currency} />
        </div>
      </section>

      {/* Stays in view while scrolling through items */}
      <div className="sticky bottom-0 -mx-5 sm:-mx-6 -mb-5 px-5 sm:px-6 py-3 bg-white/95 backdrop-blur border-t border-muted-200 space-y-2">
      {blocking && <p className="text-sm text-accent-600">{blocking}</p>}
      <div className="flex items-center gap-2">
        {!server.expense_id && (
          <button type="button" onClick={discard} className="px-4 py-3 rounded-xl text-muted-600 hover:bg-muted-100">Discard</button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving || !!blocking}
          className="flex-1 h-12 rounded-xl bg-primary-700 hover:bg-primary-800 text-white font-bold shadow-[0_5px_14px_rgba(84,63,125,0.18)] disabled:opacity-50 disabled:shadow-none"
        >
          {saving ? 'Saving…' : server.expense_id ? 'Update expense' : 'Save expense'}
          {totals && !saving && <> · {formatMinor(totals.computed_total_minor, currency)}</>}
        </button>
      </div>
      </div>

      {photo && (
        <MediaViewer
          images={server.images.map((src, i) => ({ id: src, url: resolveMediaUrl(src)!, filename: `Receipt ${i + 1}`, senderName: description || 'Receipt' }))}
          index={Math.max(0, server.images.indexOf(photo))}
          onIndexChange={(i) => setPhoto(server.images[i])}
          onClose={() => setPhoto(null)}
        />
      )}
    </div>
  );
};

const AdjustmentRow: React.FC<{
  adjustment: AdjustmentDraft;
  serverAdjustment?: ReceiptAdjustment;
  currency: string;
  members: Member[];
  itemCount: number;
  nameOf: (id: string) => string;
  onChange: (patch: Partial<AdjustmentDraft>) => void;
  onRemove: () => void;
}> = ({ adjustment: a, serverAdjustment, currency, members, itemCount, nameOf, onChange, onRemove }) => {
  const discount = DISCOUNT_KINDS.includes(a.kind);
  // Any percentage discount can be re-rated; changing a printed one makes it our own adjustment
  const usesPercent = a.percent !== null && discount;
  const setPercent = (percent: string) =>
    onChange({ percent, enabled: true, ...(a.source === 'printed' ? { source: 'manual' as const } : {}) });
  const amountMinor = serverAdjustment?.amount_minor ?? parseMajor(a.amount || '', currency) ?? 0;
  const scopeText = a.allocation === 'equal'
    ? 'Split equally between people'
    : a.allocation === 'assign'
      ? `Charged to ${a.assignee_ids.map(nameOf).join(', ') || 'nobody yet'}`
      : a.item_indexes.length && a.item_indexes.length < itemCount
        ? `On ${a.item_indexes.length} item${a.item_indexes.length === 1 ? '' : 's'}${a.allocation === 'per_unit' && a.item_indexes.length > 1 ? '' : ', by price'}`
        : 'Whole bill, by price';

  return (
    <div className={`p-3 rounded-xl border ${a.enabled ? 'border-muted-200' : 'border-dashed border-muted-300 bg-muted-50'}`}>
      <div className="flex items-center gap-2">
        <Switch checked={a.enabled} onChange={(enabled) => onChange({ enabled })} label={`Apply ${a.label}`} />
        <input
          value={a.label}
          onChange={(e) => onChange({ label: e.target.value })}
          aria-label="Label"
          className="flex-1 min-w-0 px-1 py-0.5 text-sm font-medium rounded border border-transparent hover:border-muted-200 focus:border-primary-400 focus:outline-none"
        />
        {usesPercent ? (
          <span className={`text-sm font-semibold tabular-nums ${a.enabled ? 'text-success-700' : 'text-muted-400 line-through'}`}>{formatMinor(amountMinor, currency)}</span>
        ) : (
          <MoneyInput value={a.amount || ''} currency={currency} allowNegative ariaLabel="Amount" className="w-24 py-1" onChange={(amount) => onChange({ amount })} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-muted-500">
        <span>{KIND_LABELS[a.kind] || a.kind}</span>
        <span>· {scopeText}</span>
        {a.source === 'store_rule' && <span className="text-primary-600">· Your saved discount, not printed on the receipt</span>}
        {!discount && (
          <select
            value={a.allocation}
            aria-label="How to share it"
            onChange={(e) => onChange({ allocation: e.target.value as AdjustmentDraft['allocation'], assignee_ids: e.target.value === 'assign' ? a.assignee_ids : [] })}
            className="ml-auto px-1.5 py-0.5 rounded border border-muted-200 bg-white"
          >
            <option value="proportional">By what each person had</option>
            <option value="equal">Equally per person</option>
            <option value="assign">To specific people</option>
          </select>
        )}
        {discount && a.item_indexes.length > 1 && (
          // A deal over several items ("any 3 for 2"): share it per item, or the same % off each
          <select
            value={a.allocation === 'per_unit' ? 'per_unit' : 'proportional'}
            aria-label="How to share this deal"
            onChange={(e) => onChange({ allocation: e.target.value as AdjustmentDraft['allocation'] })}
            className="ml-auto px-1.5 py-0.5 rounded border border-muted-200 bg-white"
          >
            <option value="per_unit">Each item costs the same</option>
            <option value="proportional">Same % off each item</option>
          </select>
        )}
        {a.source !== 'store_rule' && (
          <label className="flex items-center gap-1" title="Off for your own extras (e.g. a tip you add): they aren't compared with the receipt total">
            <input type="checkbox" checked={a.source === 'printed'} onChange={(e) => onChange({ source: e.target.checked ? 'printed' : 'manual' })} />
            On the receipt
          </label>
        )}
        <button type="button" onClick={onRemove} className="text-accent-600 hover:underline">Remove</button>
      </div>
      {usesPercent && (
        // Same store, different rate this time (e.g. colleague discount 10%, 15% or 20%)
        <div className="flex flex-wrap items-center gap-1.5 mt-2" role="group" aria-label="Discount rate">
          {PERCENT_PRESETS.map((preset) => {
            const active = Number((a.percent || '').replace(',', '.')) === preset;
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={active}
                onClick={() => setPercent(String(preset))}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  active ? 'border-primary-600 bg-primary-700 text-white' : 'border-muted-300 bg-white text-muted-700 hover:border-primary-400'
                }`}
              >
                {preset}%
              </button>
            );
          })}
          <span className="flex items-center gap-1 text-xs text-muted-600">
            <input
              value={a.percent || ''}
              inputMode="decimal"
              aria-label="Discount percent"
              onChange={(e) => setPercent(e.target.value)}
              className="w-14 px-2 py-1 rounded-md border border-muted-300 text-right"
            />
            %
          </span>
        </div>
      )}
      {a.allocation === 'assign' && (
        <div className="flex flex-wrap gap-2 mt-2">
          {members.map((m) => (
            <PersonToggle
              key={m.id}
              member={m}
              size="xs"
              label={nameOf(m.id)}
              selected={a.assignee_ids.includes(m.id)}
              onToggle={() => onChange({
                assignee_ids: a.assignee_ids.includes(m.id) ? a.assignee_ids.filter((u) => u !== m.id) : [...a.assignee_ids, m.id],
              })}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ReceiptReview;
