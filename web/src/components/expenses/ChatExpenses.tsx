// src/components/expenses/ChatExpenses.tsx
// Money in one chat, in four tabs:
//   You       only your own numbers: what you paid, your share, who you owe and who owes you
//   Balances  every member: paid, share, balance, and the payments that settle everyone up
//   Summary   total spent, by category, by member and by month
//   History   expenses and payments together, filtered by date, category, member or type

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { expenseService } from '../../services/expense.service';
import type { ActivityFilters, ActivityItem, Balances, CurrencySummary, ExpenseSummary } from '../../services/expense.service';
import { parseApiError } from '../../utils/apiError';
import { decimalsFor, formatMinor, parseMajor, toMajorString } from '../../utils/money';
import { payOptions } from '../../utils/pay';
import type { PayHandles } from '../../utils/pay';
import { ArrowLeft, ArrowRightLeft, BellRing, CheckCircle2, Download, Lock, MessageSquareText, PenLine, Plus, Receipt, ScrollText, Wallet } from 'lucide-react';
import { Avatar } from '../atoms';
import CategoryIcon from './CategoryIcon';
import { Approx, displayName, Money, MoneyInput, Sheet, useExpenseChanges } from './shared';
import { confirmDialog } from '../organisms/ConfirmDialog';

interface Props {
  conversationId: string;
  currentUserId: string;
  chatName: string;
  chatAvatar?: string;
  isGroup: boolean;
  onBack: () => void;
  onOpenChat: () => void;
  onOpenExpense: (expenseId: string, edit?: boolean) => void;
  onAddExpense: () => void;
}

type Tab = 'you' | 'balances' | 'summary' | 'history';
type SettleDraft = { from: string; to: string; currency: string; amount: string; editing?: string; note?: string | null };

const CATEGORIES = ['groceries', 'food', 'drinks', 'transport', 'travel', 'rent', 'utilities', 'household', 'entertainment', 'shopping', 'health', 'gifts', 'other'];
const label = (category: string) => category.charAt(0).toUpperCase() + category.slice(1);
const monthLabel = (month: string) => new Date(`${month}-01T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });

type DateRange = 'all' | 'month' | '30d' | '90d' | 'year';
function rangeOf(range: DateRange): Pick<ActivityFilters, 'date_from'> {
  const now = new Date();
  const from = {
    all: null,
    month: new Date(now.getFullYear(), now.getMonth(), 1),
    '30d': new Date(now.getTime() - 30 * 86400e3),
    '90d': new Date(now.getTime() - 90 * 86400e3),
    year: new Date(now.getFullYear(), 0, 1),
  }[range];
  return from ? { date_from: from.toISOString() } : {};
}

const Spinner = () => <div className="py-10 flex justify-center"><div className="w-8 h-8 rounded-full border-4 border-primary-200 border-t-primary-600 animate-spin" /></div>;

const ChatExpenses: React.FC<Props> = ({ conversationId, currentUserId, chatName, chatAvatar, isGroup, onBack, onOpenChat, onOpenExpense, onAddExpense }) => {
  const [tab, setTab] = useState<Tab>('you');
  const [balances, setBalances] = useState<Balances | null>(null);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [settle, setSettle] = useState<SettleDraft | null>(null);
  const [choosing, setChoosing] = useState(false); // "Settle up" with several people: pick one first
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [version, setVersion] = useState(0); // bumps when anything changes, so History reloads too

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([expenseService.balances(conversationId), expenseService.summary(conversationId)]);
      setBalances(b);
      setSummary(s);
      setVersion((v) => v + 1);
    } catch (error) {
      toast.error(parseApiError(error));
    }
  }, [conversationId]);

  useEffect(() => { load(); }, [load]);
  useExpenseChanges(conversationId, load);

  const users = summary?.users || balances?.users || {};
  const name = (id: string) => (id === currentUserId ? 'You' : displayName(users[id]));

  const download = async () => {
    setDownloading(true);
    try {
      await expenseService.downloadExcel(conversationId);
    } catch (e) {
      toast.error(parseApiError(e));
    } finally {
      setDownloading(false);
    }
  };

  const undoPayment = async (id: string) => {
    try {
      await expenseService.removeSettlement(id);
      toast.info('Payment undone');
      load();
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };

  const recordPayment = async () => {
    if (!settle) return;
    const minor = parseMajor(settle.amount, settle.currency);
    if (!minor || minor <= 0) { toast.error('Enter the amount paid'); return; }
    // More than is owed flips the balance the other way: make sure that's meant
    const owed = balances?.currencies.find((c) => c.currency === settle.currency)?.debts
      .find((d) => d.from_user === settle.from && d.to_user === settle.to)?.amount_minor || 0;
    if (!settle.editing && minor > owed && !(await confirmDialog({
      title: 'More than is owed',
      message: owed
        ? `${settle.from === currentUserId ? 'You owe' : `${name(settle.from)} owes`} ${formatMinor(owed, settle.currency)}. Recording ${formatMinor(minor, settle.currency)} means ${settle.to === currentUserId ? 'you' : name(settle.to)} will owe the difference back.`
        : `${settle.from === currentUserId ? 'You don’t' : `${name(settle.from)} doesn’t`} owe ${settle.to === currentUserId ? 'you' : name(settle.to)} anything in ${settle.currency}. Record it anyway?`,
      confirmText: 'Record anyway',
    }))) return;
    setSaving(true);
    try {
      if (settle.editing) {
        await expenseService.updateSettlement(settle.editing, { amount: settle.amount, note: settle.note });
        toast.success('Payment updated');
      } else {
        const saved = await expenseService.settle(conversationId, { from_user: settle.from, to_user: settle.to, currency: settle.currency, amount: settle.amount }) as { id: string };
        toast.success(
          <span className="flex items-center justify-between gap-3">
            Payment recorded
            <button type="button" onClick={() => undoPayment(saved.id)} className="font-bold text-primary-700 hover:underline">Undo</button>
          </span>,
        );
      }
      setSettle(null);
      load();
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const empty = !!summary && summary.currencies.length === 0;
  const otherIds = Object.keys(users).filter((id) => id !== currentUserId);

  // "Settle up": straight to the payment when there's one; otherwise choose who with
  const myDebts = (balances?.currencies || []).flatMap((c) =>
    c.debts.filter((d) => d.from_user === currentUserId || d.to_user === currentUserId).map((d) => ({ ...d, currency: c.currency })));
  const settleUp = () => {
    if (myDebts.length === 1) {
      const d = myDebts[0];
      setSettle({ from: d.from_user, to: d.to_user, currency: d.currency, amount: toMajorString(d.amount_minor, d.currency) });
    } else {
      setChoosing(true);
    }
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: 'you', label: 'You' },
    { value: 'balances', label: 'Balances' },
    { value: 'summary', label: 'Summary' },
    { value: 'history', label: 'History' },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-5 sm:py-7 space-y-5">
      <header className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="md:hidden p-2 -ml-2 rounded-lg text-muted-600 hover:bg-muted-100" aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <Avatar src={chatAvatar} alt={chatName} size="lg" />
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary-500">{isGroup ? 'Group expenses' : 'Direct expenses'}</p>
          <h2 className="font-display text-xl font-semibold text-muted-900 truncate">{chatName}</h2>
        </div>
        {isGroup && otherIds.length > 0 && (
          <div className="hidden lg:flex items-center ml-3" aria-label={`${otherIds.length + 1} people`}>
            {[currentUserId, ...otherIds].slice(0, 4).map((id) => (
              <span key={id} className="-ml-2 first:ml-0 rounded-full ring-2 ring-[#f6f6f8]">
                <Avatar src={users[id]?.avatar} alt={displayName(users[id])} size="sm" />
              </span>
            ))}
            {otherIds.length + 1 > 4 && <span className="-ml-2 w-8 h-8 rounded-full bg-primary-100 text-primary-700 text-[11px] font-bold grid place-items-center ring-2 ring-[#f6f6f8]">+{otherIds.length - 3}</span>}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onOpenChat} title="Open chat" aria-label="Open chat"
            className="inline-flex items-center gap-2 h-10 px-3 rounded-[11px] text-sm font-semibold text-muted-600 hover:bg-white">
            <MessageSquareText size={17} /> <span className="hidden sm:inline">Open chat</span>
          </button>
          {!empty && summary && (
            <button type="button" onClick={download} disabled={downloading} title="Download as Excel" aria-label="Download as Excel"
              className="inline-flex items-center gap-2 h-10 px-3 rounded-[11px] border border-primary-100 bg-primary-50 text-sm font-semibold text-primary-700 hover:bg-primary-100 disabled:opacity-50">
              <Download size={17} /> <span className="hidden sm:inline">Export to Excel</span>
            </button>
          )}
        </div>
      </header>

      {!balances || !summary ? <Spinner /> : (
        <>
          {empty ? (
            <section className="card px-6 py-12 text-center">
              <span className="mx-auto mb-4 w-20 h-20 rounded-[24px] bg-primary-50 text-primary-600 grid place-items-center">
                <Receipt size={38} strokeWidth={1.5} />
              </span>
              <h3 className="font-display text-xl font-semibold text-muted-900">Start sharing expenses</h3>
              <p className="mt-2 max-w-sm mx-auto text-sm text-muted-500">
                Add the first expense for {chatName}, or scan a receipt, and ShareEven keeps everyone’s balance fair.
              </p>
              <button type="button" onClick={onAddExpense} className="mt-6 inline-flex items-center gap-2 h-11 px-5 rounded-[11px] bg-primary-700 hover:bg-primary-800 text-white text-sm font-bold shadow-[0_5px_14px_rgba(84,63,125,0.18)]">
                <Plus size={17} /> Add first expense
              </button>
            </section>
          ) : (
            <PositionCard summary={summary} me={currentUserId} isGroup={isGroup} name={name} others={otherIds}
              onAdd={onAddExpense} onSettle={myDebts.length ? settleUp : undefined} />
          )}

          <div className="flex gap-6 sm:gap-7 border-b border-muted-200" role="tablist" aria-label="Expense views">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => setTab(t.value)}
                className={`relative py-3 text-sm font-semibold ${tab === t.value ? 'text-primary-700' : 'text-muted-500 hover:text-muted-800'}`}
              >
                {t.label}
                {tab === t.value && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-primary-700" />}
              </button>
            ))}
          </div>

          {empty && tab !== 'history' ? null : tab === 'you' ? (
            <YouTab summary={summary} balances={balances} me={currentUserId} name={name} users={users} onSettle={setSettle} conversationId={conversationId} />
          ) : tab === 'balances' ? (
            <BalancesTab summary={summary} balances={balances} me={currentUserId} name={name} users={users} onSettle={setSettle} />
          ) : tab === 'summary' ? (
            <SummaryTab summary={summary} name={name} users={users} />
          ) : (
            <HistoryTab conversationId={conversationId} me={currentUserId} name={name} users={users} version={version} onOpenExpense={onOpenExpense} onChanged={load}
              onEditPayment={(it) => setSettle({ from: it.from_user, to: it.to_user, currency: it.currency, amount: toMajorString(it.amount_minor, it.currency), editing: it.id, note: it.note })} />
          )}
        </>
      )}

      {choosing && (
        <Sheet title="Settle up with" eyebrow="Settle up" onClose={() => setChoosing(false)}>
          <ul className="-mx-2">
            {myDebts.map((d) => {
              const iOwe = d.from_user === currentUserId;
              const other = iOwe ? d.to_user : d.from_user;
              return (
                <li key={`${d.currency}-${d.from_user}-${d.to_user}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setChoosing(false);
                      setSettle({ from: d.from_user, to: d.to_user, currency: d.currency, amount: toMajorString(d.amount_minor, d.currency) });
                    }}
                    className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl text-left hover:bg-muted-50"
                  >
                    <Avatar src={users[other]?.avatar} alt={name(other)} size="sm" />
                    <span className="flex-1 min-w-0 text-sm text-muted-700 truncate">{iOwe ? `You owe ${name(other)}` : `${name(other)} owes you`}</span>
                    <Money minor={d.amount_minor} currency={d.currency} className={`text-sm font-semibold ${iOwe ? 'text-accent-600' : 'text-success-700'}`} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}

      {settle && (
        <Sheet
          title={settle.editing ? 'Edit payment' : settle.from === currentUserId ? `Pay ${name(settle.to)}` : settle.to === currentUserId ? `${name(settle.from)} paid you` : `${name(settle.from)} paid ${name(settle.to)}`}
          eyebrow={settle.editing ? 'Fix the amount' : 'Settle up'}
          onClose={() => setSettle(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-700">
              {settle.editing
                ? <>Change how much <b>{settle.from === currentUserId ? 'you' : name(settle.from)}</b> paid <b>{settle.to === currentUserId ? 'you' : name(settle.to)}</b>. Everyone in the chat is told about the change.</>
                : <>Record that <b>{settle.from === currentUserId ? 'you' : name(settle.from)}</b> paid <b>{settle.to === currentUserId ? 'you' : name(settle.to)}</b>. ShareEven doesn’t move money; pay however you like, then record it here.</>}
            </p>
            <label className="block">
              <span className="block mb-1.5 text-xs font-bold text-muted-500">Amount paid · {settle.currency}</span>
              <MoneyInput value={settle.amount} currency={settle.currency} onChange={(amount) => setSettle({ ...settle, amount })} className="w-full h-14 text-2xl font-bold" ariaLabel="Amount paid" />
            </label>
            {settle.from === currentUserId && !settle.editing && (
              <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-primary-50 text-sm text-primary-800">
                <span>Pay in your payment app first, then record it here.</span>
                <PayMenu pay={users[settle.to]?.pay} minor={parseMajor(settle.amount, settle.currency) ?? 0} currency={settle.currency} payee={displayName(users[settle.to])} />
              </div>
            )}
            <button type="button" onClick={recordPayment} disabled={saving} className="w-full h-12 rounded-xl bg-primary-700 hover:bg-primary-800 text-white font-bold disabled:opacity-50">
              {saving ? 'Saving…' : settle.editing ? 'Save changes' : 'Record payment'}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
};

type Users = ExpenseSummary['users'];
interface TabProps { summary: ExpenseSummary; balances: Balances; me: string; name: (id: string) => string; users: Users; onSettle: (d: SettleDraft) => void; conversationId?: string }

/** "Pay": the payee's payment apps, opened with the amount (or with it copied, for Revolut). */
const PayMenu: React.FC<{ pay?: PayHandles; minor: number; currency: string; payee: string }> = ({ pay, minor, currency, payee }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close); // a click anywhere else closes the menu
    return () => window.removeEventListener('click', close);
  }, [open]);
  const options = payOptions(pay, minor, currency, decimalsFor(currency), payee, 'ShareEven');
  if (!options.length) return null;
  const go = async (o: (typeof options)[number]) => {
    setOpen(false);
    if (o.copyAmount) {
      await navigator.clipboard?.writeText(toMajorString(minor, currency)).catch(() => undefined);
      toast.info(`Amount copied: paste it in ${o.label}`);
    }
    window.open(o.url, '_blank', 'noopener');
  };
  return (
    <span className="relative">
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} aria-haspopup="menu" aria-expanded={open}
        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-primary-700 text-white hover:bg-primary-800">
        <Wallet className="w-3.5 h-3.5" /> Pay
      </button>
      {open && (
        <span role="menu" className="absolute right-0 z-10 mt-1 w-40 rounded-xl border border-muted-200 bg-white shadow-elevated py-1">
          {options.map((o) => (
            <button key={o.app} type="button" role="menuitem" onClick={() => go(o)} className="block w-full px-3 py-2 text-left text-sm text-muted-800 hover:bg-muted-50">
              {o.label}{o.copyAmount ? <span className="block text-[11px] text-muted-500">copies the amount</span> : null}
            </button>
          ))}
        </span>
      )}
    </span>
  );
};

const RemindButton: React.FC<{ conversationId: string; userId: string; currency: string }> = ({ conversationId, userId, currency }) => {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const remind = async () => {
    setBusy(true);
    try {
      await expenseService.remind(conversationId, userId, currency);
      setSent(true);
      toast.success('Reminder sent');
    } catch (e) {
      toast.error(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={remind} disabled={busy || sent} title="Send them a notification"
      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-muted-200 text-muted-700 hover:bg-muted-50 disabled:opacity-50">
      <BellRing className="w-3.5 h-3.5" /> {sent ? 'Reminded' : 'Remind'}
    </button>
  );
};

const NetText: React.FC<{ net: number; currency: string; you?: boolean }> = ({ net, currency, you }) => (
  <span className={`font-semibold ${net > 0 ? 'text-success-700' : net < 0 ? 'text-accent-600' : 'text-muted-500'}`}>
    {net > 0 ? (you ? 'You get back ' : 'Gets back ') : net < 0 ? (you ? 'You owe ' : 'Owes ') : 'Settled'}
    {net !== 0 && <Money minor={Math.abs(net)} currency={currency} />}
  </span>
);

const Stat: React.FC<{ label: string; minor: number; currency: string }> = ({ label: text, minor, currency }) => (
  <div className="p-3 rounded-xl bg-[#f6f4fa]">
    <p className="text-xs text-muted-500">{text}</p>
    <p className="text-base font-semibold text-muted-900"><Money minor={minor} currency={currency} /></p>
  </div>
);

/** The purple card on top: where you stand in this chat, with the two things you'll do next. */
const PositionCard: React.FC<{
  summary: ExpenseSummary; me: string; isGroup: boolean; name: (id: string) => string; others: string[];
  onAdd: () => void; onSettle?: () => void;
}> = ({ summary, me, isGroup, name, others, onAdd, onSettle }) => {
  // Lead with the currency where you're most out of balance
  const ordered = [...summary.currencies].sort((a, b) => Math.abs(b.me.net_minor) - Math.abs(a.me.net_minor));
  const main = ordered[0];
  const net = main.me.net_minor;
  const people = others.map((id) => name(id).split(' ')[0]);
  const withWhom = people.length <= 3 ? people.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${people.slice(0, 2).join(', ')} and ${people.length - 2} others`;
  const count = summary.currencies.reduce((n, c) => n + c.count, 0);
  return (
    <section className="relative overflow-hidden rounded-[18px] p-5 sm:p-7 text-white bg-gradient-to-br from-[#4a376e] to-[#705798] shadow-[0_16px_35px_rgba(70,50,105,0.16)] grid gap-5 lg:grid-cols-[1.2fr_1fr_auto] lg:items-center" aria-label="Your position">
      <span className="absolute -right-28 -top-36 w-64 h-64 rounded-full border border-white/10" aria-hidden />
      <div className="relative">
        <p className="text-[11px] uppercase tracking-[0.12em] text-primary-100">Your position</p>
        <h3 className="mt-2 font-display text-lg sm:text-xl font-semibold leading-snug">
          {net === 0 ? <>You’re settled up {isGroup ? 'in this group' : 'here'}</> : (
            <>
              {net > 0 ? 'You are owed ' : 'You owe '}
              <span className={`text-[26px] sm:text-[29px] font-bold ${net < 0 ? 'text-[#ffc9d1]' : ''}`}><Money minor={Math.abs(net)} currency={main.currency} /></span>
              {isGroup ? ' in this group' : ''}
            </>
          )}
        </h3>
        {net !== 0 && <Approx minor={Math.abs(net)} currency={main.currency} className="block text-sm font-semibold text-primary-100" />}
        <p className="mt-1.5 text-xs text-primary-100">
          {count} expense{count === 1 ? '' : 's'}{withWhom ? ` with ${withWhom}` : ''}
          {ordered.length > 1 && ` · also ${ordered.slice(1).map((c) => c.currency).join(', ')}`}
        </p>
      </div>
      <div className="relative grid grid-cols-3 gap-2 lg:gap-4">
        {[
          { label: `${main.currency} balance`, value: <>{net > 0 ? '+' : net < 0 ? '−' : ''}<Money minor={Math.abs(net)} currency={main.currency} /></> },
          { label: 'You paid', value: <Money minor={main.me.paid_minor} currency={main.currency} /> },
          { label: 'Your share', value: <Money minor={main.me.share_minor} currency={main.currency} /> },
        ].map((stat) => (
          <div key={stat.label} className="min-w-0 rounded-xl bg-white/10 lg:bg-transparent px-3 py-2.5 lg:p-0">
            <p className="text-[11px] text-primary-100 truncate">{stat.label}</p>
            <p className="font-bold tabular-nums truncate">{stat.value}</p>
          </div>
        ))}
      </div>
      <div className="relative grid grid-cols-2 lg:grid-cols-1 gap-2.5">
        <button type="button" onClick={onAdd}
          className="h-11 px-5 rounded-[11px] bg-[#2f2246]/60 hover:bg-[#2f2246]/80 text-sm font-bold inline-flex items-center justify-center gap-2">
          <Plus size={17} /> Add expense
        </button>
        {onSettle && (
          <button type="button" onClick={onSettle}
            className="h-11 px-5 rounded-[11px] bg-white/15 hover:bg-white/25 border border-white/25 text-sm font-bold">
            Settle up
          </button>
        )}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------- You (6.1)

const YouTab: React.FC<TabProps> = ({ summary, balances, me, name, users, onSettle, conversationId }) => (
  <div className="space-y-4">
    {summary.currencies.map((c) => {
      const debts = balances.currencies.find((b) => b.currency === c.currency)?.debts.filter((d) => d.from_user === me || d.to_user === me) || [];
      return (
        <section key={c.currency} className="card p-5 space-y-4" aria-label={`Your ${c.currency} balance`}>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-muted-500">{c.currency}</span>
            <NetText net={c.me.net_minor} currency={c.currency} you />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="You paid" minor={c.me.paid_minor} currency={c.currency} />
            <Stat label="Your share" minor={c.me.share_minor} currency={c.currency} />
            <Stat label="You paid back" minor={c.me.sent_minor} currency={c.currency} />
            <Stat label="Paid back to you" minor={c.me.received_minor} currency={c.currency} />
          </div>
          {debts.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-success-700"><CheckCircle2 className="w-4 h-4" /> Nothing to settle</p>
          ) : (
            <ul className="space-y-2">
              {debts.map((d) => {
                const other = d.from_user === me ? d.to_user : d.from_user;
                const iOwe = d.from_user === me;
                return (
                  <li key={`${d.from_user}-${d.to_user}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                    <Avatar src={users[other]?.avatar} alt={displayName(users[other])} size="sm" />
                    <span className="flex-1 min-w-0 truncate">{iOwe ? <>You owe <b>{name(other)}</b></> : <><b>{name(other)}</b> owes you</>}</span>
                    <Money minor={d.amount_minor} currency={c.currency} className={`font-semibold ${iOwe ? 'text-accent-600' : 'text-success-700'}`} />
                    <span className="flex items-center gap-2 w-full sm:w-auto justify-end">
                    {iOwe
                      ? <PayMenu pay={users[other]?.pay} minor={d.amount_minor} currency={c.currency} payee={displayName(users[other])} />
                      : conversationId && <RemindButton conversationId={conversationId} userId={other} currency={c.currency} />}
                    <button type="button" onClick={() => onSettle({ from: d.from_user, to: d.to_user, currency: c.currency, amount: toMajorString(d.amount_minor, c.currency) })}
                      className="px-2.5 py-1 text-xs rounded-lg bg-primary-50 text-primary-700 hover:bg-primary-100">
                      {iOwe ? 'Settle' : 'Mark paid'}
                    </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      );
    })}
    <p className="text-xs text-muted-400">Only your own amounts are shown here. See Balances for everyone.</p>
  </div>
);

// ---------------------------------------------------------------- Balances (6.2)

const BalancesTab: React.FC<TabProps> = ({ summary, balances, me, name, users, onSettle }) => (
  <div className="space-y-4">
    {summary.currencies.map((c) => {
      const debts = balances.currencies.find((b) => b.currency === c.currency)?.debts || [];
      return (
        <section key={c.currency} className="card p-5" aria-label={`${c.currency} balances`}>
          <h3 className="text-sm font-medium text-muted-500 mb-2">{c.currency} · each member</h3>
          <ul className="divide-y divide-muted-100">
            {c.members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 py-2.5">
                <Avatar src={users[m.user_id]?.avatar} alt={displayName(users[m.user_id])} size="sm" />
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm truncate ${m.user_id === me ? 'font-semibold text-muted-900' : 'text-muted-800'}`}>{name(m.user_id)}</span>
                  <span className="block text-xs text-muted-500">
                    Paid <Money minor={m.paid_minor} currency={c.currency} /> · share <Money minor={m.share_minor} currency={c.currency} />
                  </span>
                </span>
                <span className="text-sm"><NetText net={m.net_minor} currency={c.currency} /></span>
              </li>
            ))}
          </ul>
          <h3 className="text-sm font-medium text-muted-500 mt-4 mb-2 flex items-center gap-1.5"><ArrowRightLeft className="w-4 h-4" /> To settle up</h3>
          {debts.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-success-700"><CheckCircle2 className="w-4 h-4" /> Everyone is settled up</p>
          ) : (
            <ul className="space-y-2">
              {debts.map((d) => (
                <li key={`${d.from_user}-${d.to_user}`} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0 truncate"><b>{name(d.from_user)}</b> {d.from_user === me ? 'pay' : 'pays'} <b>{d.to_user === me ? 'you' : name(d.to_user)}</b></span>
                  <Money minor={d.amount_minor} currency={c.currency} className="font-semibold" />
                  <button type="button" onClick={() => onSettle({ from: d.from_user, to: d.to_user, currency: c.currency, amount: toMajorString(d.amount_minor, c.currency) })}
                    className="px-2.5 py-1 text-xs rounded-lg bg-primary-50 text-primary-700 hover:bg-primary-100">Record</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    })}
    <p className="text-xs text-muted-400">
      {balances.simplified ? 'Payments are simplified to the fewest needed.' : 'Showing who owes whom directly.'} Change this in the chat’s info.
    </p>
  </div>
);

// ---------------------------------------------------------------- Summary (6.3)

// Category colours, in a fixed order (validated for colour-blind separation); the rest fold into "Other"
const SLICE_COLORS = ['#4a3aa7', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER_COLOR = '#94a3b8';
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** Donut of spending by category: thin ring, 2px gaps between slices, total in the middle. */
const Donut: React.FC<{ slices: { label: string; value: number; color: string }[]; total: React.ReactNode; active: number | null; onHover: (i: number | null) => void }> = ({
  slices, total, active, onHover,
}) => {
  const size = 180;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const sum = slices.reduce((a, x) => a + x.value, 0) || 1;
  const gap = slices.length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-44 h-44 flex-shrink-0" role="img" aria-label="Spending by category">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f0f5" strokeWidth={stroke} />
      {slices.map((sl, i) => {
        const len = (sl.value / sum) * c;
        const dash = Math.max(len - gap, 0.5);
        const el = (
          <circle
            key={sl.label}
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={sl.color}
            strokeWidth={active === i ? stroke + 6 : stroke}
            strokeDasharray={`${dash} ${c - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="transition-[stroke-width] cursor-pointer"
            opacity={active === null || active === i ? 1 : 0.35}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
          >
            <title>{`${sl.label}: ${pct(sl.value, sum)}%`}</title>
          </circle>
        );
        offset += len;
        return el;
      })}
      <foreignObject x={stroke} y={stroke} width={size - stroke * 2} height={size - stroke * 2}>
        <div className="w-full h-full flex flex-col items-center justify-center text-center">{total}</div>
      </foreignObject>
    </svg>
  );
};

const SummaryTab: React.FC<{ summary: ExpenseSummary; name: (id: string) => string; users: Users }> = ({ summary, name, users }) => {
  const [hover, setHover] = useState<{ currency: string; index: number } | null>(null);
  const thisMonth = new Date().toISOString().slice(0, 7);
  return (
    <div className="space-y-4">
      {summary.currencies.map((c: CurrencySummary) => {
        const cats = [...c.by_category].sort((a, b) => b.total_minor - a.total_minor);
        const top = cats.slice(0, SLICE_COLORS.length);
        const rest = cats.slice(SLICE_COLORS.length);
        const slices = [
          ...top.map((cat, i) => ({ label: label(cat.category), value: cat.total_minor, color: SLICE_COLORS[i], count: cat.count, category: cat.category })),
          ...(rest.length ? [{ label: 'Other', value: rest.reduce((a, x) => a + x.total_minor, 0), color: OTHER_COLOR, count: rest.reduce((a, x) => a + x.count, 0), category: 'other' }] : []),
        ];
        const active = hover?.currency === c.currency ? hover.index : null;
        const months = [...c.by_month].reverse().slice(-6); // oldest → newest, last six
        const topMonth = Math.max(...months.map((m) => m.total_minor), 1);
        const monthNow = c.by_month.find((m) => m.month === thisMonth)?.total_minor || 0;
        const spenders = c.members.filter((m) => m.paid_minor || m.share_minor);
        const topMember = Math.max(...spenders.map((m) => Math.max(m.paid_minor, m.share_minor)), 1);
        return (
          <section key={c.currency} className="space-y-4" aria-label={`${c.currency} summary`}>
            {/* Headline numbers */}
            <div className="card p-5 sm:p-6">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted-500">Total spent · {c.currency}</p>
              <p className="mt-1 font-display text-4xl font-bold tracking-tight text-muted-900"><Money minor={c.total_minor} currency={c.currency} /></p>
              <Approx minor={c.total_minor} currency={c.currency} className="text-sm text-muted-500" />
              <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { k: 'Expenses', v: String(c.count) },
                  { k: 'Average', v: <Money minor={c.count ? Math.round(c.total_minor / c.count) : 0} currency={c.currency} /> },
                  { k: 'This month', v: <Money minor={monthNow} currency={c.currency} /> },
                  { k: 'Top category', v: cats[0] ? label(cats[0].category) : '—' },
                ].map((t) => (
                  <div key={t.k} className="rounded-xl bg-[#f6f4fa] px-3.5 py-3">
                    <p className="text-[11px] font-semibold text-muted-500">{t.k}</p>
                    <p className="mt-0.5 font-bold text-muted-900 truncate tabular-nums">{t.v}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* By category: donut + legend (the legend carries every label and amount) */}
              <div className="card p-5">
                <h3 className="font-display font-semibold text-muted-900">By category</h3>
                <div className="mt-4 flex flex-col sm:flex-row items-center gap-5">
                  <Donut
                    slices={slices}
                    active={active}
                    onHover={(i) => setHover(i === null ? null : { currency: c.currency, index: i })}
                    total={<>
                      <span className="text-[11px] text-muted-500">{active !== null ? slices[active].label : 'Total'}</span>
                      <span className="font-display text-lg font-bold text-muted-900 leading-tight">
                        {active !== null ? `${pct(slices[active].value, c.total_minor)}%` : <Money minor={c.total_minor} currency={c.currency} />}
                      </span>
                    </>}
                  />
                  <ul className="flex-1 w-full space-y-1">
                    {slices.map((sl, i) => (
                      <li key={sl.label}
                        onMouseEnter={() => setHover({ currency: c.currency, index: i })}
                        onMouseLeave={() => setHover(null)}
                        className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm ${active === i ? 'bg-muted-50' : ''}`}>
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: sl.color }} aria-hidden />
                        <span className="flex-1 min-w-0 truncate text-muted-800">{sl.label} <span className="text-xs text-muted-400">· {sl.count}</span></span>
                        <Money minor={sl.value} currency={c.currency} className="font-semibold text-muted-900" />
                        <span className="w-9 text-right text-xs text-muted-500 tabular-nums">{pct(sl.value, c.total_minor)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* By month: thin bars, newest highlighted */}
              <div className="card p-5">
                <h3 className="font-display font-semibold text-muted-900">By month</h3>
                <p className="text-xs text-muted-500">Last {months.length} month{months.length === 1 ? '' : 's'} with spending</p>
                <div className="mt-4 h-44 flex items-end gap-3" role="img" aria-label="Spending by month">
                  {months.map((m, i) => {
                    const latest = i === months.length - 1;
                    return (
                      <div key={m.month} className="group relative flex-1 h-full flex flex-col justify-end items-center gap-1.5" title={`${monthLabel(m.month)}: ${formatMinor(m.total_minor, c.currency)}`}>
                        <span className={`text-[10px] font-semibold tabular-nums ${latest ? 'text-primary-700' : 'text-muted-400 opacity-0 group-hover:opacity-100'}`}>
                          {formatMinor(m.total_minor, c.currency)}
                        </span>
                        <div className={`w-full max-w-[28px] rounded-t ${latest ? 'bg-primary-600' : 'bg-primary-200 group-hover:bg-primary-300'}`}
                          style={{ height: `${Math.max(4, (m.total_minor / topMonth) * 100)}%` }} />
                        <span className="text-[11px] text-muted-500">{new Date(`${m.month}-01T12:00:00`).toLocaleDateString([], { month: 'short' })}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* By member: what each paid against their share */}
            <div className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display font-semibold text-muted-900">By member</h3>
                <span className="flex items-center gap-3 text-xs text-muted-500">
                  <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-primary-600" /> Paid</span>
                  <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-primary-200" /> Share</span>
                </span>
              </div>
              <ul className="mt-3 space-y-3">
                {spenders.map((m) => (
                  <li key={m.user_id} className="flex items-center gap-3">
                    <Avatar src={users[m.user_id]?.avatar} alt={displayName(users[m.user_id])} size="sm" />
                    <span className="flex-1 min-w-0 space-y-1">
                      <span className="flex justify-between gap-2 text-sm">
                        <span className="truncate text-muted-800">{name(m.user_id)}</span>
                        <span className="text-muted-500 tabular-nums"><Money minor={m.paid_minor} currency={c.currency} className="font-semibold text-muted-900" /> · <Money minor={m.share_minor} currency={c.currency} /></span>
                      </span>
                      <span className="block h-1.5 rounded-full bg-muted-100 overflow-hidden"><span className="block h-full rounded-full bg-primary-600" style={{ width: `${(m.paid_minor / topMember) * 100}%` }} /></span>
                      <span className="block h-1.5 rounded-full bg-muted-100 overflow-hidden"><span className="block h-full rounded-full bg-primary-200" style={{ width: `${(m.share_minor / topMember) * 100}%` }} /></span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------- History with filters (6.4)

const HistoryTab: React.FC<{
  conversationId: string; me: string; name: (id: string) => string; users: Users; version: number;
  onOpenExpense: (id: string, edit?: boolean) => void; onChanged: () => void; onEditPayment: (payment: Extract<ActivityItem, { kind: 'settlement' }>) => void;
}> = ({ conversationId, me, name, users, version, onOpenExpense, onChanged, onEditPayment }) => {
  const [range, setRange] = useState<DateRange>('all');
  const [category, setCategory] = useState('');
  const [member, setMember] = useState('');
  const [kind, setKind] = useState<'' | 'expense' | 'settlement'>('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [items, setItems] = useState<ActivityItem[] | null>(null);

  const filters = useMemo<ActivityFilters>(() => ({
    ...rangeOf(range), ...(category ? { category } : {}), ...(member ? { member } : {}), ...(kind ? { kind } : {}), include_deleted: showDeleted,
  }), [range, category, member, kind, showDeleted]);

  useEffect(() => {
    let alive = true;
    expenseService.activity(conversationId, filters).then((r) => { if (alive) setItems(r.items); }).catch((e) => toast.error(parseApiError(e)));
    return () => { alive = false; };
  }, [conversationId, filters, version]);

  const removePayment = async (id: string) => {
    if (!(await confirmDialog({ title: 'Undo this payment?', message: 'Balances go back to how they were before it, and the chat is told.', confirmText: 'Undo payment', danger: true }))) return;
    try {
      await expenseService.removeSettlement(id);
      onChanged();
    } catch (e) {
      toast.error(parseApiError(e));
    }
  };

  const select = 'h-9 px-2.5 text-sm rounded-[10px] border border-muted-200 bg-white text-muted-700';
  const filtered = range !== 'all' || category || member || kind;

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2 pb-4 mb-2 border-b border-muted-100" role="group" aria-label="Filters">
        <select value={range} onChange={(e) => setRange(e.target.value as DateRange)} aria-label="Date" className={select}>
          <option value="all">All time</option>
          <option value="month">This month</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 3 months</option>
          <option value="year">This year</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className={select}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </select>
        <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Member" className={select}>
          <option value="">Everyone</option>
          {Object.keys(users).map((id) => <option key={id} value={id}>{name(id)}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Type" className={select}>
          <option value="">Expenses and payments</option>
          <option value="expense">Expenses only</option>
          <option value="settlement">Payments only</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-muted-500">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Deleted
        </label>
        {filtered && (
          <button type="button" onClick={() => { setRange('all'); setCategory(''); setMember(''); setKind(''); }} className="text-xs font-medium text-primary-700 hover:underline">Clear</button>
        )}
      </div>

      {!items ? <Spinner /> : items.length === 0 ? (
        <p className="text-sm text-muted-500 py-6 text-center">{filtered ? 'Nothing matches these filters.' : 'No expenses or payments yet.'}</p>
      ) : (
        <ul className="divide-y divide-muted-100" aria-label="History">
          {items.map((it) => {
            const when = new Date(it.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
            if (it.kind === 'settlement') {
              return (
                <li key={`s-${it.id}`} className="flex items-center gap-3 py-2.5">
                  <span className="inline-flex w-8 h-8 flex-shrink-0 items-center justify-center rounded-full bg-success-50 text-success-700"><ArrowRightLeft className="w-4 h-4" /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-muted-900 truncate">{name(it.from_user)} paid {it.to_user === me ? 'you' : name(it.to_user)}</span>
                    <span className="block text-xs text-muted-500">Payment · {when}{it.note ? ` · ${it.note}` : ''}</span>
                  </span>
                  <Money minor={it.amount_minor} currency={it.currency} className="text-sm font-medium" />
                  {!it.deleted && [it.created_by, it.from_user, it.to_user].includes(me) && (
                    <span className="flex items-center gap-1">
                      <button type="button" onClick={() => onEditPayment(it)} className="px-2 py-1 rounded-md text-xs font-semibold text-primary-700 hover:bg-primary-50" aria-label="Edit payment">Edit</button>
                      <button type="button" onClick={() => removePayment(it.id)} className="px-2 py-1 rounded-md text-xs font-semibold text-muted-500 hover:bg-accent-50 hover:text-accent-600" aria-label="Undo payment">Undo</button>
                    </span>
                  )}
                </li>
              );
            }
            const net = (it.payers.find((p) => p.user_id === me)?.amount_minor || 0) - (it.shares.find((s) => s.user_id === me)?.amount_minor || 0);
            const payer = it.payers.length > 1 ? `${it.payers.length} people` : name(it.payers[0]?.user_id || '');
            return (
              <li key={`e-${it.id}`} className="group flex items-center gap-1">
                <button type="button" onClick={() => onOpenExpense(it.id)} className={`flex-1 min-w-0 flex items-center gap-3 py-2.5 text-left ${it.deleted ? 'opacity-50' : ''}`}>
                  <CategoryIcon category={it.category} size="sm" />
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm font-medium text-muted-900 truncate ${it.deleted ? 'line-through' : ''}`}>
                      {it.description}
                      {it.locked && <Lock className="inline w-3.5 h-3.5 ml-1 text-muted-400" aria-label="Locked" />}
                      {it.source === 'receipt' && <ScrollText className="inline w-3.5 h-3.5 ml-1 text-primary-500" aria-label="From a receipt" />}
                    </span>
                    <span className="block text-xs text-muted-500">{payer} paid <Money minor={it.total_minor} currency={it.currency} /> · {label(it.category)} · {when}</span>
                  </span>
                  <span className={`text-sm font-medium ${net > 0 ? 'text-success-700' : net < 0 ? 'text-accent-600' : 'text-muted-400'}`} title={net > 0 ? 'You lent' : net < 0 ? 'You borrowed' : 'Not involved'}>
                    {net === 0 ? '—' : <>{net > 0 ? '+' : '−'}<Money minor={Math.abs(net)} currency={it.currency} /></>}
                    {net !== 0 && <Approx minor={Math.abs(net)} currency={it.currency} className="block text-[11px] font-normal text-muted-400" />}
                  </span>
                </button>
                {it.can_edit && !it.deleted && !it.locked && (
                  <button type="button" onClick={() => onOpenExpense(it.id, true)} title="Edit" aria-label={`Edit ${it.description}`}
                    className="flex-shrink-0 p-2 rounded-lg text-muted-400 hover:text-primary-700 hover:bg-primary-50 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                    <PenLine size={15} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default ChatExpenses;
