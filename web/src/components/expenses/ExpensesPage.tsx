// src/components/expenses/ExpensesPage.tsx
// The Expenses tab: your overall balance, every chat with its balance, and the chosen chat's money.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, LayoutDashboard, Search } from 'lucide-react';
import { Avatar } from '../atoms';
import { expenseService } from '../../services/expense.service';
import type { ExpensesOverview } from '../../services/expense.service';
import { Approx, displayName, Money, useDisplayCurrency, useExpenseChanges } from './shared';
import ExpensesHome from './ExpensesHome';
import AddExpenseSheet from './AddExpenseSheet';
import ChatExpenses from './ChatExpenses';
import ExpenseDetail from './ExpenseDetail';

interface ChatSummary {
  id: string;
  name: string;
  avatar?: string;
  isGroup?: boolean;
  members?: string[];
}

interface Props {
  conversations: ChatSummary[];
  currentUserId: string;
}

type Filter = 'all' | 'owe' | 'owed';
/** Your balance in each chat: conversation id → currency → amount (positive: you're owed). */
type ChatNets = Record<string, Record<string, number>>;

function netsByChat(data: ExpensesOverview | null): ChatNets {
  const nets: ChatNets = {};
  data?.people.forEach((p) => p.chats.forEach((ch) => {
    const chat = (nets[ch.conversation_id] ||= {});
    chat[p.currency] = (chat[p.currency] || 0) + ch.amount_minor;
  }));
  return nets;
}

const ExpensesPage: React.FC<Props> = ({ conversations, currentUserId }) => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('chat') || undefined;
  const selected = conversations.find((c) => c.id === selectedId);
  // Groups by default; a direct chat shows up once it has expenses (or with "Show all chats")
  const [withExpenses, setWithExpenses] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [overview, setOverview] = useState<ExpensesOverview | null>(null);

  const loadOverview = React.useCallback(() => { expenseService.overview().then(setOverview).catch(() => undefined); }, []);
  useEffect(() => { loadOverview(); }, [loadOverview]);
  useExpenseChanges(undefined, loadOverview);
  useEffect(() => {
    expenseService.conversationsWithExpenses().then((ids) => setWithExpenses(new Set(ids))).catch(() => undefined);
  }, [conversations]);

  const nets = useMemo(() => netsByChat(overview), [overview]);
  const sign = (id: string) => {
    const values = Object.values(nets[id] || {});
    return { owed: values.some((v) => v > 0), owe: values.some((v) => v < 0) };
  };

  const shown = useMemo(
    () => conversations.filter((c) => showAll || c.isGroup || withExpenses.has(c.id) || c.id === selectedId),
    [conversations, showAll, withExpenses, selectedId],
  );
  const hidden = conversations.length - shown.length;
  const listed = shown.filter((c) => {
    if (query.trim() && !c.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (filter === 'owe') return sign(c.id).owe;
    if (filter === 'owed') return sign(c.id).owed;
    return true;
  });
  const [openExpense, setOpenExpense] = useState<{ id: string; edit?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);

  const chips: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'owe', label: 'You owe' },
    { value: 'owed', label: 'Owed to you' },
  ];

  return (
    <div className="flex h-full">
      <aside className={`w-full md:w-[340px] flex-shrink-0 border-r border-muted-200 bg-white overflow-y-auto px-4 md:px-5 pt-6 pb-6 ${selected ? 'hidden md:block' : ''}`}>
        <div className="px-1 mb-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary-500">Shared money</p>
          <h1 className="mt-0.5 font-display text-[25px] font-semibold text-muted-900">Expenses</h1>
        </div>

        <Overview data={overview} conversations={conversations} onOpenChat={(id) => setParams({ chat: id })} />

        <label className="mt-5 h-[42px] flex items-center gap-2.5 px-3 rounded-xl bg-[#f6f6f8] border border-transparent focus-within:border-primary-400 focus-within:bg-white text-muted-500">
          <Search size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people or groups"
            aria-label="Search people or groups"
            className="flex-1 min-w-0 bg-transparent outline-none text-sm text-muted-900 placeholder:text-muted-400"
          />
        </label>
        <div className="flex gap-2 mt-4 mb-4" role="group" aria-label="Filter">
          {chips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              onClick={() => setFilter(chip.value)}
              aria-pressed={filter === chip.value}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                filter === chip.value ? 'bg-primary-100 text-primary-700 border-transparent' : 'bg-white text-muted-500 border-muted-200 hover:text-muted-800'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setParams({})}
          aria-current={!selected ? 'true' : undefined}
          className={`hidden md:flex w-full items-center gap-3 mb-3 px-2.5 py-2.5 rounded-[14px] text-left ${!selected ? 'bg-primary-50' : 'hover:bg-primary-50/60'}`}
        >
          <span className="w-12 h-12 rounded-full bg-primary-100 text-primary-700 grid place-items-center"><LayoutDashboard size={20} /></span>
          <span className="min-w-0">
            <span className="block font-bold text-muted-900">Overview</span>
            <span className="block text-xs text-muted-500">Totals and recent activity</span>
          </span>
        </button>
        <p className="px-2 pb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-500">People & groups</p>
        <ul className="space-y-0.5">
          {listed.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setParams({ chat: c.id })}
                aria-current={c.id === selectedId ? 'true' : undefined}
                className={`w-full grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-2.5 py-2.5 rounded-[14px] text-left ${
                  c.id === selectedId ? 'bg-primary-50' : 'hover:bg-primary-50/60'
                }`}
              >
                <Avatar src={c.avatar} alt={c.name} size="lg" group={c.isGroup} />
                <span className="min-w-0">
                  <span className="block font-bold text-muted-900 truncate">{c.name}</span>
                  <span className="block text-xs text-muted-500 truncate">
                    {c.isGroup ? `${c.members?.length || 0} members` : 'Direct expenses'}
                  </span>
                </span>
                <ChatNet nets={nets[c.id]} />
              </button>
            </li>
          ))}
          {listed.length === 0 && (
            <li className="px-2 py-6 text-sm text-muted-500">
              {shown.length === 0 ? 'Create a group to share expenses.' : 'Nothing matches.'}
            </li>
          )}
          {(hidden > 0 || showAll) && (
            <li className="px-2 py-3">
              <button type="button" onClick={() => setShowAll((v) => !v)} className="text-sm font-semibold text-primary-700 hover:underline">
                {showAll ? 'Show groups only' : `Show all chats (${hidden} direct)`}
              </button>
            </li>
          )}
        </ul>
        {!selected && (
          <div className="md:hidden mt-5">
            <ExpensesHome activityOnly overview={overview} currentUserId={currentUserId}
              onOpenChat={(id) => setParams({ chat: id })} onOpenExpense={(id, edit) => setOpenExpense({ id, edit })} />
          </div>
        )}
      </aside>

      <main className={`flex-1 min-w-0 overflow-y-auto bg-[#f6f6f8] ${selected ? '' : 'hidden md:block'}`}>
        {selected ? (
          <ChatExpenses
            key={selected.id}
            conversationId={selected.id}
            currentUserId={currentUserId}
            chatName={selected.name}
            chatAvatar={selected.avatar}
            isGroup={!!selected.isGroup}
            onBack={() => setParams({})}
            onOpenChat={() => navigate(`/chat/${selected.id}`)}
            onOpenExpense={(id, edit) => setOpenExpense({ id, edit })}
            onAddExpense={() => setAdding(true)}
          />
        ) : (
          <ExpensesHome overview={overview} currentUserId={currentUserId}
            onOpenChat={(id) => setParams({ chat: id })} onOpenExpense={(id, edit) => setOpenExpense({ id, edit })} />
        )}
      </main>

      {openExpense && (
        <ExpenseDetail expenseId={openExpense.id} startEditing={openExpense.edit} currentUserId={currentUserId} onClose={() => setOpenExpense(null)} />
      )}
      {adding && selected && (
        <AddExpenseSheet conversationId={selected.id} currentUserId={currentUserId} onClose={() => setAdding(false)} />
      )}
    </div>
  );
};

/** A chat's balance on the right of its row: the first currency, plus how many more. */
const ChatNet: React.FC<{ nets?: Record<string, number> }> = ({ nets }) => {
  const entries = Object.entries(nets || {}).filter(([, v]) => v !== 0);
  if (!entries.length) return <span className="text-xs font-semibold text-muted-400">Settled</span>;
  const [currency, minor] = entries[0];
  return (
    <span className={`text-right text-[13px] font-bold tabular-nums ${minor > 0 ? 'text-success-700' : 'text-accent-500'}`}>
      {minor > 0 ? '+' : '−'}<Money minor={Math.abs(minor)} currency={currency} />
      <Approx minor={Math.abs(minor)} currency={currency} className="block text-[10px] font-semibold text-muted-400" />
      {entries.length > 1 && <span className="block text-[10px] font-semibold text-muted-400">+{entries.length - 1} more</span>}
    </span>
  );
};

/** Your money across every chat: totals per currency, then one line per person (tap to see the chats). */
const Overview: React.FC<{ data: ExpensesOverview | null; conversations: ChatSummary[]; onOpenChat: (id: string) => void }> = ({ data, conversations, onOpenChat }) => {
  const [open, setOpen] = useState<string | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const { target, convert } = useDisplayCurrency();
  if (!data) return null;
  // Everything together in the display currency, when one is set and amounts are in others
  const together = target && data.currencies.some((c) => c.currency !== target)
    ? data.currencies.reduce<number | null>((sum, c) => {
      const v = convert(c.net_minor, c.currency);
      return sum === null || v === null ? null : sum + v;
    }, 0)
    : null;
  const chatName = (id: string, title: string | null) => title || conversations.find((c) => c.id === id)?.name || 'Direct chat';
  const [main, ...others] = data.currencies;

  return (
    <section aria-label="Overall">
      <div className="relative overflow-hidden rounded-[18px] p-5 text-white bg-gradient-to-br from-[#4a376e] to-[#705798] shadow-[0_16px_35px_rgba(70,50,105,0.16)]">
        <span className="absolute -right-24 -top-28 w-56 h-56 rounded-full border border-white/10" aria-hidden />
        <p className="text-[11px] uppercase tracking-[0.12em] text-primary-100">Overall</p>
        {!main ? (
          <p className="mt-2 font-display text-xl font-semibold">You’re all settled up</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-primary-100">
              {main.net_minor > 0 ? 'You are owed' : main.net_minor < 0 ? 'You owe' : 'Settled'}
            </p>
            <p className={`font-display text-[32px] leading-tight font-bold tracking-tight ${main.net_minor < 0 ? 'text-[#ffc9d1]' : ''}`}>
              <Money minor={Math.abs(main.net_minor)} currency={main.currency} />
            </p>
            <p className="mt-1 text-xs text-primary-100">
              Owed to you <Money minor={main.owed_minor} currency={main.currency} /> · you owe <Money minor={main.owe_minor} currency={main.currency} />
            </p>
            {together !== null && target && (
              <p className="mt-2 text-sm font-semibold">
                ≈ {together < 0 ? '−' : '+'}<Money minor={Math.abs(together)} currency={target} /> overall in {target}
              </p>
            )}
            {others.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {others.map((c) => (
                  <span key={c.currency} className="px-2.5 py-1 rounded-lg bg-white/10 text-xs font-semibold">
                    {c.net_minor >= 0 ? '+' : '−'}<Money minor={Math.abs(c.net_minor)} currency={c.currency} />
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {data.people.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowPeople((v) => !v)}
            aria-expanded={showPeople}
            className="w-full flex items-center justify-between px-2 py-1.5 text-sm font-semibold text-primary-700"
          >
            By person ({data.people.length})
            <ChevronDown size={16} className={`transition-transform ${showPeople ? 'rotate-180' : ''}`} />
          </button>
          {showPeople && (
            <ul className="mt-1 space-y-0.5">
              {data.people.map((p) => {
                const key = `${p.user_id}-${p.currency}`;
                return (
                  <li key={key}>
                    <button type="button" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}
                      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left text-sm hover:bg-muted-50">
                      <Avatar src={data.users[p.user_id]?.avatar || undefined} alt={displayName(data.users[p.user_id])} size="sm" />
                      <span className="flex-1 min-w-0 truncate text-muted-800">{displayName(data.users[p.user_id])}</span>
                      <span className={`font-semibold ${p.net_minor > 0 ? 'text-success-700' : 'text-accent-500'}`}>
                        {p.net_minor > 0 ? 'owes you ' : 'you owe '}<Money minor={Math.abs(p.net_minor)} currency={p.currency} />
                      </span>
                    </button>
                    {open === key && (
                      <ul className="ml-12 mb-1 space-y-0.5">
                        {p.chats.map((ch) => (
                          <li key={ch.conversation_id}>
                            <button type="button" onClick={() => onOpenChat(ch.conversation_id)} className="w-full flex justify-between py-0.5 text-xs text-muted-600 hover:text-primary-700">
                              <span className="truncate">{ch.is_group ? chatName(ch.conversation_id, ch.title) : 'Direct chat'}</span>
                              <span>{ch.amount_minor > 0 ? '+' : '−'}<Money minor={Math.abs(ch.amount_minor)} currency={p.currency} /></span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default ExpensesPage;
