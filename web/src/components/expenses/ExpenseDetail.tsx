// src/components/expenses/ExpenseDetail.tsx
// One expense: who paid, who owes, the receipt photos, and the full history of changes.

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Lock, LockOpen, PenLine, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import CategoryIcon from './CategoryIcon';
import { toast } from 'react-toastify';
import { expenseService } from '../../services/expense.service';
import type { Expense, HistoryEntry, Receipt } from '../../services/expense.service';
import { parseApiError } from '../../utils/apiError';
import { resolveMediaUrl } from '../../utils/media';
import { shareLines } from '../../utils/shareBreakdown';
import AddExpenseSheet from './AddExpenseSheet';
import { displayName, Money, Segmented, Sheet, useChatMoney, useExpenseChanges } from './shared';
import { confirmDialog } from '../organisms/ConfirmDialog';

interface Props {
  expenseId: string;
  currentUserId: string;
  onClose: () => void;
  startEditing?: boolean; // open straight into the edit form (the Edit button on a history row)
}

const ACTION_ICONS: Record<HistoryEntry['action'], LucideIcon> = {
  created: Plus, updated: PenLine, deleted: Trash2, restored: RotateCcw, locked: Lock, unlocked: LockOpen,
};

const ExpenseDetail: React.FC<Props> = ({ expenseId, currentUserId, onClose, startEditing }) => {
  const [expense, setExpense] = useState<Expense | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [editing, setEditing] = useState<'manual' | 'receipt' | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
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
      if (startEditing && e.can_edit && !e.deleted) setEditing((current) => current ?? 'manual');
    } catch (error) {
      toast.error(parseApiError(error));
      onClose();
    }
  }, [expenseId, onClose, startEditing]);

  useEffect(() => { load(); }, [load]);
  useExpenseChanges(expense?.conversation_id, load);

  const nameOf = (id: string) =>
    id === currentUserId ? 'You' : displayName(members.find((m) => m.id === id));
  const initials = (id: string) => {
    if (id === currentUserId) return 'You';
    const words = nameOf(id).trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 1)).toUpperCase();
  };

  // One calm purple: a badge per person, thin lines between people, your own row lightly tinted.
  // On a receipt split, tapping someone shows the items their share is made of.
  const personRow = (userId: string, minor: number, options: { label?: string; breakdown?: boolean } = {}) => {
    const lines = options.breakdown && receipt ? shareLines(receipt, userId, minor) : null;
    const itemCount = lines?.filter((l) => l.key.startsWith('i')).length || 0;
    const isOpen = !!lines && open === userId;
    const mine = userId === currentUserId;
    const row = (
      <>
        <span className={`w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold ${mine ? 'bg-primary-600 text-white' : 'bg-primary-100 text-primary-700'}`} aria-hidden>
          {initials(userId)}
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className={`block truncate ${mine ? 'font-semibold text-primary-800' : 'font-medium text-muted-900'}`}>
            {nameOf(userId)}{options.label && <span className="font-normal text-muted-500"> {options.label}</span>}
          </span>
          {lines && <span className="block text-xs text-muted-500">{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>}
        </span>
        <Money minor={minor} currency={expense?.currency || ''} className="font-semibold text-muted-900" />
        {lines && <ChevronDown size={16} className={`flex-shrink-0 text-muted-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
      </>
    );
    return (
      <li key={userId} className={mine ? 'bg-primary-50/70' : undefined}>
        {lines ? (
          <button type="button" onClick={() => setOpen(isOpen ? null : userId)} aria-expanded={isOpen}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-primary-50 transition-colors">
            {row}
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2.5 text-sm">{row}</div>
        )}
        {isOpen && lines && (
          <ul className="mx-3 mb-3 rounded-lg bg-white border border-primary-100 divide-y divide-primary-50">
            {lines.map((l) => (
              <li key={l.key} className="flex items-start justify-between gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0">
                  <span className="block text-muted-800">{l.label}</span>
                  {l.detail && <span className="block text-xs text-muted-500">{l.detail}</span>}
                </span>
                <Money minor={l.amount} currency={expense?.currency || ''} className="flex-shrink-0 text-muted-900" />
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  const act = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      toast.success(done);
      load();
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };

  if (!expense) {
    return (
      <Sheet title="Expense" onClose={onClose}>
        <div className="py-16 flex justify-center">
          <div className="w-8 h-8 rounded-full border-4 border-primary-200 border-t-primary-600 animate-spin" />
        </div>
      </Sheet>
    );
  }

  if (editing) {
    return (
      <AddExpenseSheet
        conversationId={expense.conversation_id}
        currentUserId={currentUserId}
        expense={editing === 'manual' ? expense : undefined}
        receiptId={editing === 'receipt' ? expense.receipt_id || undefined : undefined}
        onClose={() => { if (startEditing) { onClose(); return; } setEditing(null); load(); }}
      />
    );
  }

  const myShare = expense.shares.find((s) => s.user_id === currentUserId)?.amount_minor || 0;
  const myPaid = expense.payers.find((p) => p.user_id === currentUserId)?.amount_minor || 0;
  const editable = expense.can_edit;

  return (
    <Sheet title={expense.description} onClose={onClose}>
      <div className="text-center mb-4">
        <CategoryIcon category={expense.category} size="lg" />
        <Money minor={expense.total_minor} currency={expense.currency} className="block text-3xl font-bold text-muted-900 mt-1" />
        <p className="text-sm text-muted-500">
          {expense.spent_at && new Date(expense.spent_at).toLocaleDateString()}
          {expense.source === 'receipt' && ' · from a receipt'}
          {expense.locked && ' · locked'}
        </p>
        {expense.deleted && <p className="mt-2 text-sm font-medium text-accent-600">This expense was deleted</p>}
        <p className={`mt-2 text-sm font-medium ${myPaid - myShare > 0 ? 'text-success-700' : myPaid - myShare < 0 ? 'text-accent-600' : 'text-muted-500'}`}>
          {myPaid - myShare > 0 && <>You get back <Money minor={myPaid - myShare} currency={expense.currency} /></>}
          {myPaid - myShare < 0 && <>You owe <Money minor={myShare - myPaid} currency={expense.currency} /></>}
          {myPaid === myShare && (myShare ? 'You’re even on this one' : 'You’re not involved')}
        </p>
      </div>

      <div className="flex justify-center mb-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'details', label: 'Details' }, { value: 'history', label: `History (${history.length})` }]} />
      </div>

      {tab === 'details' ? (
        <div className="space-y-5">
          <section>
            <h3 className="text-sm font-semibold text-muted-700 mb-2">Paid by</h3>
            <ul className="rounded-xl border border-muted-200 divide-y divide-muted-100 overflow-hidden">
              {expense.payers.map((p) => personRow(p.user_id, p.amount_minor))}
            </ul>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-muted-700 mb-2">Split {expense.split_mode === 'itemized' ? 'by item' : expense.split_mode === 'equal' ? 'equally' : `by ${expense.split_mode}`}</h3>
            <ul className="rounded-xl border border-muted-200 divide-y divide-muted-100 overflow-hidden">
              {expense.shares.map((s) => personRow(s.user_id, s.amount_minor, {
                label: s.split_value && expense.split_mode === 'percent' ? `(${s.split_value}%)` : undefined,
                breakdown: expense.split_mode === 'itemized',
              }))}
            </ul>
            {receipt && expense.split_mode === 'itemized' && (
              <p className="mt-1.5 text-xs text-muted-500">Tap someone to see their items.</p>
            )}
          </section>
          {expense.receipt_images.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-muted-700 mb-2">Receipt</h3>
              <div className="flex gap-2">
                {expense.receipt_images.map((src) => (
                  <button key={src} type="button" onClick={() => setPhoto(src)} className="w-16 h-20 rounded-lg overflow-hidden border border-muted-200">
                    <img src={resolveMediaUrl(src)} alt="Receipt" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            {!expense.deleted && editable && (
              <button type="button" onClick={() => setEditing('manual')} className="px-3 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium">
                {expense.split_mode === 'itemized' ? 'Edit details & payers' : 'Edit'}
              </button>
            )}
            {!expense.deleted && editable && expense.receipt_id && (
              <button type="button" onClick={() => setEditing('receipt')} className="px-3 py-2 rounded-lg bg-primary-50 text-primary-700 text-sm font-medium">
                Edit items
              </button>
            )}
            {expense.can_admin && !expense.deleted && (
              <button type="button" onClick={() => act(() => expenseService.lock(expense.id, !expense.locked), expense.locked ? 'Unlocked' : 'Locked')} className="px-3 py-2 rounded-lg bg-muted-100 text-sm font-medium">
                {expense.locked ? 'Unlock' : 'Lock'}
              </button>
            )}
            {expense.can_delete && !expense.locked && (
              <button
                type="button"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Delete this expense?', message: 'It can be restored later.', confirmText: 'Delete', danger: true })) {
                    act(() => expenseService.remove(expense.id), 'Expense deleted');
                  }
                }}
                className="ml-auto px-3 py-2 rounded-lg text-accent-600 hover:bg-accent-50 text-sm font-medium"
              >
                Delete
              </button>
            )}
            {expense.deleted && (expense.can_admin || expense.created_by === currentUserId) && (
              <button type="button" onClick={() => act(() => expenseService.restore(expense.id), 'Expense restored')} className="px-3 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium">
                Restore
              </button>
            )}
          </div>
        </div>
      ) : (
        <ol className="space-y-3">
          {history.map((h) => (
            <li key={h.id} className="flex gap-3">
              {(() => {
                const ActionIcon = ACTION_ICONS[h.action];
                return (
                  <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-full bg-primary-50 text-primary-700 flex items-center justify-center">
                    <ActionIcon className="w-3.5 h-3.5" aria-hidden />
                  </span>
                );
              })()}
              <div className="min-w-0">
                <p className="text-sm text-muted-900">
                  <span className="font-semibold">{h.actor ? (h.actor.id === currentUserId ? 'You' : h.actor.username) : 'Someone'}</span> {h.summary}
                </p>
                <p className="text-xs text-muted-500">{new Date(h.created_at).toLocaleString()}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {photo && (
        <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4" onClick={() => setPhoto(null)}>
          <img src={resolveMediaUrl(photo)} alt="Receipt" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </Sheet>
  );
};

export default ExpenseDetail;
