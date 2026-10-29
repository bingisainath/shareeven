// src/components/organisms/SupportSettings.tsx
// Settings → Contact support (send a request, see the answers), and (app admins) the support inbox.

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { LifeBuoy } from 'lucide-react';
import { Avatar } from '../atoms';
import { SUPPORT_CATEGORIES, supportService } from '../../services/support.service';
import type { SupportCategory, SupportTicket, SupportTicketForAdmin } from '../../services/support.service';
import { parseApiError } from '../../utils/apiError';

const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find((x) => x.value === c)?.label || c;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const field = 'w-full px-3 text-sm rounded-lg border border-muted-200 bg-white focus:outline-none focus:ring-2 focus:ring-primary-300';

const StatusPill: React.FC<{ t: SupportTicket }> = ({ t }) => (
  <span className={`flex-shrink-0 text-[10px] font-bold px-2 py-[3px] rounded-[10px] ${
    t.reply ? 'bg-success-50 text-success-700' : t.status === 'closed' ? 'bg-muted-100 text-muted-600' : 'bg-warning-50 text-warning-700'}`}>
    {t.reply ? 'Answered' : t.status === 'closed' ? 'Closed' : 'Waiting for reply'}
  </span>
);

export const ContactSupport: React.FC = () => {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [category, setCategory] = useState<SupportCategory>('bug');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const load = useCallback(() => { supportService.mine().then(setTickets).catch(() => setTickets([])); }, []);
  useEffect(load, [load]);

  const ready = subject.trim().length >= 3 && message.trim().length >= 10 && !sending;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setSending(true);
    try {
      await supportService.send({ category, subject: subject.trim(), message: message.trim(), app_info: `Web · ${navigator.userAgent.slice(0, 80)}` });
      toast.success("Sent. We'll reply here and in Notices.");
      setSubject('');
      setMessage('');
      load();
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <form onSubmit={send} className="card p-4 sm:p-6 space-y-3">
        <h2 className="text-lg font-semibold text-muted-900 flex items-center gap-2"><LifeBuoy className="w-5 h-5 text-primary-700" /> Ask us for help</h2>
        <p className="text-sm text-muted-500">
          Tell us what went wrong or what you'd like. The ShareEven team reads every request and replies here and under Notices.
          Don't include passwords or your recovery key. To report a person or a message, use Report in the chat instead.
        </p>
        <label className="block text-sm font-medium text-muted-800">
          What's it about?
          <select value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)} className={`${field} mt-1 h-10`}>
            {SUPPORT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium text-muted-800">
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder="e.g. Receipt scan stuck on Reading"
            className={`${field} mt-1 h-10`} />
        </label>
        <label className="block text-sm font-medium text-muted-800">
          Details
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={3000} rows={5}
            placeholder="What did you do, what happened, and what did you expect?" className={`${field} mt-1 py-2 resize-y`} />
          <span className="block mt-1 text-xs text-muted-400 text-right">{message.length}/3000</span>
        </label>
        <div className="flex justify-end">
          <button type="submit" disabled={!ready} aria-busy={sending}
            className="px-4 h-10 text-sm font-semibold text-white bg-primary-700 rounded-lg disabled:opacity-50">
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      {!!tickets?.length && (
        <div className="card p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-muted-900">Your requests</h2>
          <ul className="mt-2 divide-y divide-muted-100">
            {tickets.map((t) => (
              <li key={t.id} className="py-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-muted-900 break-words">{t.subject}</span>
                    <span className="block text-xs text-muted-500">{categoryLabel(t.category)} · {when(t.created_at)}</span>
                  </span>
                  <StatusPill t={t} />
                </div>
                <p className="text-sm text-muted-700 whitespace-pre-wrap break-words">{t.message}</p>
                {t.reply && (
                  <div className="p-3 rounded-lg bg-primary-50 text-sm text-muted-800">
                    <span className="block text-xs font-bold text-primary-700">ShareEven support · {when(t.replied_at)}</span>
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{t.reply}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
};

/** The admin console's support inbox. onOpenUser opens the sender's account. */
export const SupportInbox: React.FC<{ onOpenUser?: (id: string) => void }> = ({ onOpenUser }) => {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [tickets, setTickets] = useState<SupportTicketForAdmin[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { supportService.inbox(status).then(setTickets).catch((e) => toast.error(parseApiError(e))); }, [status]);
  useEffect(() => { setTickets(null); load(); }, [load]);

  const act = async (t: SupportTicketForAdmin, run: () => Promise<unknown>, done: string) => {
    setBusy(t.id);
    try {
      await run();
      toast.success(done);
      setDrafts(({ [t.id]: _gone, ...rest }) => rest);
      load();
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-muted-900 flex items-center gap-2"><LifeBuoy className="w-5 h-5 text-primary-700" /> Support requests</h2>
        <div className="inline-flex p-[3px] bg-[#f1f0f5] rounded-[11px]" role="tablist">
          {(['open', 'closed'] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
              className={`px-3 py-1.5 text-sm font-semibold rounded-[9px] ${status === s ? 'bg-white text-primary-700 shadow-sm' : 'text-muted-500'}`}>
              {s === 'open' ? 'Open' : 'Closed'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-muted-500">Only app admins see this. Your reply goes to the person as a notice, with a push to their phone.</p>
      {tickets && tickets.length === 0 && <p className="mt-3 text-sm text-muted-400">Nothing {status === 'open' ? 'waiting' : 'closed yet'}.</p>}
      <ul className="mt-3 space-y-3">
        {(tickets || []).map((t) => {
          const draft = drafts[t.id] || '';
          return (
            <li key={t.id} className="p-4 rounded-xl border border-muted-200 space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-muted-900 break-words">{t.subject}</span>
                <span className="text-xs text-muted-500">{categoryLabel(t.category)} · {when(t.created_at)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-700">
                <Avatar src={t.user.avatar || undefined} alt={t.user.name || t.user.username} size="sm" />
                <span className="min-w-0 truncate"><b>{t.user.name || t.user.username}</b> @{t.user.username}</span>
                {onOpenUser && <button type="button" onClick={() => onOpenUser(t.user.id)} className="text-xs font-semibold text-primary-700 hover:underline">Open account</button>}
              </div>
              <p className="text-sm p-2.5 rounded-lg bg-muted-50 text-muted-800 whitespace-pre-wrap break-words">{t.message}</p>
              {t.app_info && <p className="text-xs text-muted-400 break-all">Sent from {t.app_info}</p>}
              {t.reply && (
                <p className="text-sm text-success-700 whitespace-pre-wrap break-words">Replied {when(t.replied_at)}: {t.reply}</p>
              )}
              {t.status === 'open' && (
                <div className="pt-1 space-y-2">
                  <textarea value={draft} onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))} rows={3} maxLength={3000}
                    placeholder="Reply (they'll read this)" aria-label={`Reply to ${t.user.username}`} className={`${field} py-2 resize-y`} />
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" disabled={busy === t.id} onClick={() => act(t, () => supportService.close(t.id), 'Closed')}
                      className="px-3 h-9 text-sm font-semibold text-muted-600 rounded-lg hover:bg-muted-100 disabled:opacity-50">Close without reply</button>
                    <button type="button" disabled={!draft.trim() || busy === t.id} onClick={() => act(t, () => supportService.reply(t.id, draft.trim(), false), 'Reply sent; still open')}
                      className="px-3 h-9 text-sm font-semibold text-primary-700 bg-primary-50 rounded-lg disabled:opacity-50">Reply, keep open</button>
                    <button type="button" disabled={!draft.trim() || busy === t.id} onClick={() => act(t, () => supportService.reply(t.id, draft.trim(), true), 'Reply sent and closed')}
                      className="px-3 h-9 text-sm font-semibold text-white bg-primary-700 rounded-lg disabled:opacity-50">Reply and close</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
