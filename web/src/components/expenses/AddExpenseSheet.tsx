// src/components/expenses/AddExpenseSheet.tsx
// "Add expense" from a chat: scan a receipt or enter it by hand. Also used to edit.

import React, { useState } from 'react';
import { PenLine, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Expense } from '../../services/expense.service';
import ManualExpenseForm from './ManualExpenseForm';
import ReceiptScan from './ReceiptScan';
import { Sheet, useChatMoney } from './shared';

interface Props {
  conversationId: string;
  currentUserId: string;
  expense?: Expense; // edit a manual expense (or the details of a receipt one)
  receiptId?: string; // continue reviewing a receipt
  initialTab?: 'scan' | 'manual';
  onClose: () => void;
  onSaved?: (expense: Expense) => void;
}

const ENTRY_OPTIONS: { value: 'scan' | 'manual'; label: string; hint: string; icon: LucideIcon }[] = [
  { value: 'scan', label: 'Scan receipt', hint: 'Split item by item with AI', icon: Sparkles },
  { value: 'manual', label: 'Enter manually', hint: 'Type the amount and split', icon: PenLine },
];

const AddExpenseSheet: React.FC<Props> = ({ conversationId, currentUserId, expense, receiptId, initialTab, onClose, onSaved }) => {
  const [tab, setTab] = useState<'scan' | 'manual'>(receiptId ? 'scan' : expense ? 'manual' : initialTab || 'scan');
  const { members, settings } = useChatMoney(conversationId);

  const done = (saved: Expense) => {
    onSaved?.(saved);
    onClose();
  };

  return (
    <Sheet title={expense ? 'Edit expense' : receiptId ? 'Review receipt' : 'Add an expense'} eyebrow={expense ? undefined : tab === 'scan' ? 'AI receipt scan' : 'New expense'} onClose={onClose} wide={tab === 'scan'}>
      {!expense && !receiptId && (
        <div className="grid grid-cols-2 gap-2.5 mb-5" role="tablist" aria-label="How to add it">
          {ENTRY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={tab === o.value}
              onClick={() => setTab(o.value)}
              className={`flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3 p-3 sm:p-3.5 rounded-[14px] border text-left transition-colors ${
                tab === o.value ? 'border-primary-400 bg-primary-50' : 'border-muted-200 bg-white hover:bg-muted-50'
              }`}
            >
              <span className={`w-9 h-9 flex-shrink-0 rounded-[10px] grid place-items-center ${tab === o.value ? 'bg-primary-700 text-white' : 'bg-primary-50 text-primary-700'}`}>
                <o.icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-muted-900">{o.label}</span>
                <span className="block text-xs text-muted-500 sm:truncate">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {!members.length || !settings ? (
        <div className="py-16 flex justify-center">
          <div className="w-8 h-8 rounded-full border-4 border-primary-200 border-t-primary-600 animate-spin" />
        </div>
      ) : tab === 'scan' ? (
        <ReceiptScan
          conversationId={conversationId}
          members={members}
          currentUserId={currentUserId}
          receiptId={receiptId}
          onSaved={done}
          onManual={() => setTab('manual')}
          onClose={onClose}
        />
      ) : (
        <ManualExpenseForm
          conversationId={conversationId}
          members={members}
          currentUserId={currentUserId}
          defaultCurrency={settings.default_currency}
          expense={expense}
          onDone={done}
        />
      )}
    </Sheet>
  );
};

export default AddExpenseSheet;
