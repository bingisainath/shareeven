// src/pages/Admin/index.tsx
// The admin console (/admin), app admins only: overview numbers, people (find, suspend, sign out,
// delete), reports, receipt AI, the Pro plan and its payment providers, and the log of what admins did. The server checks admin rights on every call;
// hiding this page is only for convenience.

import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { ArrowLeft, Ban, CircleAlert, Flag, History, LayoutDashboard, LogOut, ScanLine, Search, ShieldCheck, Sparkles, Trash2, Undo2, User, Users, X } from 'lucide-react';
import { useAuth } from '../../app/AuthProvider';
import { BrandMark } from '../../components/organisms/AuthLayout';
import { ReportsReview } from '../../components/organisms/SafetySettings';
import DailyBars from '../../components/admin/DailyBars';
import { AdminAISettings } from '../../components/expenses/ExpenseSettingsSections';
import AdminBilling from '../../components/admin/AdminBilling';
import { adminService } from '../../services/admin.service';
import { REPORT_REASONS, safetyService } from '../../services/safety.service';
import type { ReportReason } from '../../services/safety.service';
import type { AccountDetails, AccountFilter, AccountSummary, AdminActionView, Overview, ScanAllowance } from '../../services/admin.service';
import { parseApiError } from '../../utils/apiError';
import { avatarTone } from '../../utils/avatarTone';
import { formatPrice } from '../../utils/plans';

type Tab = 'overview' | 'people' | 'reports' | 'receipt-ai' | 'billing' | 'activity';

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'people', label: 'People', icon: Users },
  { id: 'reports', label: 'Reports', icon: Flag },
  { id: 'receipt-ai', label: 'Receipt AI', icon: ScanLine },
  { id: 'billing', label: 'Pro & payments', icon: Sparkles },
  { id: 'activity', label: 'Admin log', icon: History },
];

const fmt = (n: number) => n.toLocaleString();
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never');
const nameOf = (u: { name: string | null; username: string }) => u.name || u.username;

const ACTION_LABELS: Record<string, string> = {
  view_user: 'Viewed account', suspend: 'Suspended', unsuspend: 'Lifted suspension', sign_out: 'Signed out everywhere',
  delete_account: 'Deleted account', resolve_report: 'Resolved report', warn: 'Warned',
  ai_model_added: 'Added AI model', ai_model_changed: 'Changed AI model', scan_limit_changed: 'Changed the app scan limit',
  scan_limit_set: 'Set scan limit', extra_scans: 'Gave extra scans', plan_changed: 'Changed the Pro plan',
  pro_granted: 'Gave Pro', pro_ended: 'Ended Pro',
};

const AdminPage: React.FC = () => {
  const { user } = useAuth();
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : 'overview';
  const [openUser, setOpenUser] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Admin · ShareEven';
    return () => { document.title = 'ShareEven'; };
  }, []);

  if (!user?.is_app_admin) return <Navigate to="/chat" replace />;

  const showUser = (id: string) => { setOpenUser(id); if (tab !== 'people') navigate('/admin/people'); };

  return (
    <div className="min-h-screen bg-muted-50">
      <header className="bg-white border-b border-muted-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandMark />
            <span className="hidden sm:inline px-2 py-0.5 rounded-md bg-primary-50 text-primary-700 text-xs font-bold">Admin</span>
          </div>
          <Link to="/settings" className="inline-flex items-center gap-1.5 text-sm font-bold text-primary-700 hover:underline">
            <ArrowLeft size={16} /> Back to app
          </Link>
        </div>
        <nav className="max-w-6xl mx-auto px-2 sm:px-4 flex gap-1 overflow-x-auto" aria-label="Admin sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <Link key={id} to={`/admin/${id}`} aria-current={tab === id ? 'page' : undefined}
              className={`inline-flex items-center gap-2 px-3 py-3 text-sm font-semibold border-b-2 whitespace-nowrap ${
                tab === id ? 'border-primary-700 text-primary-700' : 'border-transparent text-muted-500 hover:text-muted-800'}`}>
              <Icon size={16} /> {label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <p className="mb-5 flex items-center gap-2 text-xs text-muted-500">
          <ShieldCheck size={14} /> Messages are end-to-end encrypted: admins see accounts and counts, never what people wrote. Every action here is logged.
        </p>
        {tab === 'overview' && <OverviewTab />}
        {tab === 'people' && <PeopleTab openUser={openUser} setOpenUser={setOpenUser} />}
        {tab === 'reports' && <ReportsReview onOpenUser={showUser} />}
        {tab === 'receipt-ai' && <AdminAISettings />}
        {tab === 'billing' && <AdminBilling />}
        {tab === 'activity' && <ActivityTab onOpenUser={showUser} />}
      </main>
    </div>
  );
};

// ------------------------------------------------------------------ overview

const Stat: React.FC<{ label: string; value: number; note?: string }> = ({ label, value, note }) => (
  <div className="card p-4">
    <p className="text-xs font-semibold text-muted-500">{label}</p>
    <p className="mt-1 text-2xl font-semibold text-muted-900 tabular-nums">{fmt(value)}</p>
    {note && <p className="mt-0.5 text-xs text-muted-400">{note}</p>}
  </div>
);

const OverviewTab: React.FC = () => {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    adminService.overview(days).then(setData).catch((e) => toast.error(parseApiError(e)));
  }, [days]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-muted-900">Overview</h1>
        <div className="inline-flex p-[3px] bg-[#f1f0f5] rounded-[11px]" role="group" aria-label="Time range">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
              className={`px-3 py-1.5 text-sm font-semibold rounded-[9px] ${days === d ? 'bg-white text-primary-700 shadow-sm' : 'text-muted-500'}`}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      {!data ? <p className="text-sm text-muted-400">Loading…</p> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Accounts" value={data.totals.users} />
            <Stat label="Active today" value={data.totals.active_today} note="Last 24 hours" />
            <Stat label="Active this week" value={data.totals.active_7_days} />
            <Stat label="Active this month" value={data.totals.active_30_days} />
            <Stat label="Suspended" value={data.totals.suspended} />
            <Stat label="Open reports" value={data.totals.open_reports} />
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <DailyBars title="Sign-ups" series={data.series.signups} />
            <DailyBars title="Messages sent" series={data.series.messages} />
            <DailyBars title="Expenses added" series={data.series.expenses} />
            <DailyBars title="Receipt scans" series={data.series.receipt_scans} />
          </div>

          <div className="card p-4 sm:p-5">
            <h2 className="font-semibold text-muted-900">Receipt scans by AI model</h2>
            <p className="text-sm text-muted-500">Last {data.days} days. "App key" scans are paid by you; "Own key" scans by the person's own API key.</p>
            {data.receipt_models.length === 0 ? <p className="mt-3 text-sm text-muted-400">No scans in this period.</p> : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-muted-500">
                    <tr><th className="py-2 font-semibold">Model</th><th className="py-2 font-semibold">Key</th>
                      <th className="py-2 font-semibold text-right">Scans</th><th className="py-2 font-semibold text-right">Input tokens</th>
                      <th className="py-2 font-semibold text-right">Output tokens</th></tr>
                  </thead>
                  <tbody>
                    {data.receipt_models.map((m) => (
                      <tr key={`${m.model}-${m.key}`} className="border-t border-muted-100">
                        <td className="py-2 font-medium text-muted-900">{m.model}</td>
                        <td className="py-2 text-muted-600">{m.key === 'own' ? 'Own key' : 'App key'}</td>
                        <td className="py-2 text-right tabular-nums">{fmt(m.scans)}</td>
                        <td className="py-2 text-right tabular-nums">{fmt(m.input_tokens)}</td>
                        <td className="py-2 text-right tabular-nums">{fmt(m.output_tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ people

const FILTERS: { id: AccountFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'reported', label: 'Reported' }, { id: 'suspended', label: 'Suspended' }, { id: 'admins', label: 'Admins' },
];

const Badge: React.FC<{ tone: 'danger' | 'warning' | 'primary'; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`px-1.5 py-0.5 rounded-md text-[11px] font-bold ${
    tone === 'danger' ? 'bg-accent-50 text-accent-700' : tone === 'warning' ? 'bg-warning-50 text-warning-700' : 'bg-primary-50 text-primary-700'}`}>
    {children}
  </span>
);

const AccountBadges: React.FC<{ a: AccountSummary }> = ({ a }) => (
  <>
    {a.is_app_admin && <Badge tone="primary">Admin</Badge>}
    {a.suspension && <Badge tone="danger">Suspended</Badge>}
    {a.pro_until && <Badge tone="primary">Pro</Badge>}
    {a.reports_against > 0 && <Badge tone="warning">Reported {a.reports_against}×</Badge>}
  </>
);

const PeopleTab: React.FC<{ openUser: string | null; setOpenUser: (id: string | null) => void }> = ({ openUser, setOpenUser }) => {
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<AccountFilter>('all');
  const [result, setResult] = useState<{ users: AccountSummary[]; more: boolean } | null>(null);

  const load = useCallback((offset = 0) => {
    adminService.users(query, show, offset)
      .then((r) => setResult((prev) => (offset && prev ? { users: [...prev.users, ...r.users], more: r.more } : r)))
      .catch((e) => toast.error(parseApiError(e)));
  }, [query, show]);

  useEffect(() => {
    const timer = setTimeout(() => load(0), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_420px] gap-5 items-start">
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap gap-2">
          <label className="relative flex-1 min-w-[220px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search username, name or email"
              aria-label="Search accounts" className="w-full h-10 pl-9 pr-3 rounded-xl border border-muted-200 bg-white text-sm outline-none focus:border-primary-500 focus:ring-4 focus:ring-primary-100" />
          </label>
          <div className="inline-flex p-[3px] bg-[#f1f0f5] rounded-[11px]" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" onClick={() => setShow(f.id)} aria-pressed={show === f.id}
                className={`px-3 py-1.5 text-sm font-semibold rounded-[9px] ${show === f.id ? 'bg-white text-primary-700 shadow-sm' : 'text-muted-500'}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card divide-y divide-muted-100 overflow-hidden">
          {!result ? <p className="p-4 text-sm text-muted-400">Loading…</p> : result.users.length === 0 ? (
            <p className="p-4 text-sm text-muted-400">No accounts match.</p>
          ) : result.users.map((a) => (
            <button key={a.id} type="button" onClick={() => setOpenUser(a.id)}
              className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted-50 ${openUser === a.id ? 'bg-primary-50/60' : ''}`}>
              <Avatar a={a} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-muted-900 truncate">{nameOf(a)}</span>
                  <AccountBadges a={a} />
                </span>
                <span className="block text-xs text-muted-500 truncate">@{a.username} · {a.email}</span>
              </span>
              <span className="hidden sm:block text-right text-xs text-muted-500 flex-shrink-0">
                Joined {new Date(a.created_at).toLocaleDateString()}<br />Active {a.last_active ? new Date(a.last_active).toLocaleDateString() : 'never'}
              </span>
            </button>
          ))}
        </div>
        {result?.more && (
          <button type="button" onClick={() => load(result.users.length)} className="text-sm font-semibold text-primary-700 hover:underline">Show more</button>
        )}
      </div>

      {openUser && <AccountPanel id={openUser} onClose={() => setOpenUser(null)} onChanged={() => load(0)} />}
    </div>
  );
};

const Avatar: React.FC<{ a: AccountSummary; size?: number }> = ({ a, size = 36 }) => (
  a.avatar
    ? <img src={a.avatar} alt="" className="rounded-full object-cover flex-shrink-0" style={{ width: size, height: size }} />
    : <span className="rounded-full grid place-items-center flex-shrink-0" style={{ width: size, height: size, backgroundColor: avatarTone(nameOf(a)).bg, color: avatarTone(nameOf(a)).fg }}>
        <User style={{ width: size * 0.48, height: size * 0.48 }} strokeWidth={1.9} aria-hidden />
      </span>
);

type PanelAction = 'warn' | 'suspend' | 'unsuspend' | 'sign_out' | 'delete' | null;

const DURATIONS: { label: string; days: number | null }[] = [
  { label: '1 day', days: 1 }, { label: '7 days', days: 7 }, { label: '30 days', days: 30 }, { label: 'Until lifted', days: null },
];

const AccountPanel: React.FC<{ id: string; onClose: () => void; onChanged: () => void }> = ({ id, onClose, onChanged }) => {
  const [a, setA] = useState<AccountDetails | null>(null);
  const [action, setAction] = useState<PanelAction>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState<number | null>(7);
  const [rule, setRule] = useState<ReportReason>('harassment');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminService.user(id).then(setA).catch((e) => toast.error(parseApiError(e)));
  }, [id]);
  useEffect(() => { setA(null); setAction(null); load(); }, [load]);

  const start = (next: PanelAction) => { setAction(next); setReason(''); setConfirm(''); };

  const run = async () => {
    if (!a || !action) return;
    setBusy(true);
    try {
      if (action === 'warn') {
        await safetyService.warn(a.id, rule, reason.trim());
        toast.success(`Warning sent to @${a.username}`);
      }
      if (action === 'suspend') await adminService.suspend(a.id, reason.trim(), days);
      if (action === 'unsuspend') await adminService.unsuspend(a.id, reason.trim());
      if (action === 'sign_out') {
        const r = await adminService.signOut(a.id, reason.trim());
        toast.success(`Signed out of ${r.sessions} session${r.sessions === 1 ? '' : 's'}`);
      }
      if (action === 'delete') {
        await adminService.remove(a.id, reason.trim(), confirm);
        toast.success(`Deleted @${a.username}`);
        onChanged();
        onClose();
        return;
      }
      setAction(null);
      load();
      onChanged();
    } catch (e) {
      toast.error(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = reason.trim().length >= 3 && (action !== 'delete' || confirm.trim().replace(/^@/, '') === a?.username);
  const protectedAccount = !!a && (a.is_app_admin || a.deleted);

  return (
    <aside className="card p-5 lg:sticky lg:top-4 space-y-4" aria-label="Account">
      <div className="flex items-start justify-between gap-3">
        {a ? (
          <div className="flex items-center gap-3 min-w-0">
            <Avatar a={a} size={48} />
            <div className="min-w-0">
              <p className="font-semibold text-muted-900 truncate">{nameOf(a)}</p>
              <p className="text-sm text-muted-500 truncate">@{a.username}</p>
              <p className="mt-1 flex flex-wrap gap-1.5"><AccountBadges a={a} /></p>
            </div>
          </div>
        ) : <p className="text-sm text-muted-400">Loading…</p>}
        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-muted-500 hover:bg-muted-100"><X size={18} /></button>
      </div>

      {a && (
        <>
          {a.suspension && (
            <div className="p-3 rounded-xl bg-accent-50 text-sm text-accent-700">
              Suspended {when(a.suspension.since)}{a.suspension.until ? `, until ${when(a.suspension.until)}` : ', until lifted'}.
              {a.suspension.reason && <> Reason: {a.suspension.reason}</>}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Fact label="Email" value={`${a.email}${a.email_verified ? '' : ' (not verified)'}`} wide />
            <Fact label="Joined" value={when(a.created_at)} />
            <Fact label="Last active" value={when(a.last_active)} />
            <Fact label="Direct chats" value={fmt(a.counts.direct_chats)} />
            <Fact label="Groups" value={fmt(a.counts.groups)} />
            <Fact label="Messages sent" value={fmt(a.counts.messages_sent)} />
            <Fact label="Expenses added" value={fmt(a.counts.expenses_added)} />
            <Fact label="Receipts scanned" value={fmt(a.counts.receipts_scanned)} />
            <Fact label="Signed-in sessions" value={fmt(a.counts.signed_in_sessions)} />
            <Fact label="Blocked by" value={`${fmt(a.counts.blocked_by)} people`} />
            <Fact label="Reports made" value={fmt(a.counts.reports_made)} />
            <Fact label="Warnings" value={fmt(a.counts.warnings ?? 0)} />
          </dl>

          {!protectedAccount && (
            <div className="flex flex-wrap gap-2">
              <ActionButton icon={CircleAlert} label="Warn" onClick={() => start('warn')} />
              {a.suspension
                ? <ActionButton icon={Undo2} label="Lift suspension" onClick={() => start('unsuspend')} />
                : <ActionButton icon={Ban} label="Suspend" danger onClick={() => start('suspend')} />}
              <ActionButton icon={LogOut} label="Sign out everywhere" onClick={() => start('sign_out')} />
              <ActionButton icon={Trash2} label="Delete account" danger onClick={() => start('delete')} />
            </div>
          )}
          {a.is_app_admin && <p className="text-xs text-muted-500">Admin accounts can't be suspended or deleted here. Remove the admin role on the server first.</p>}

          {action && (
            <div className="p-4 rounded-xl border border-muted-200 space-y-3">
              <p className="text-sm font-semibold text-muted-900">
                {action === 'warn' && `Warn @${a.username}?`}
                {action === 'suspend' && `Suspend @${a.username}?`}
                {action === 'unsuspend' && `Lift @${a.username}'s suspension?`}
                {action === 'sign_out' && `Sign @${a.username} out everywhere?`}
                {action === 'delete' && `Delete @${a.username}'s account?`}
              </p>
              <p className="text-xs text-muted-500">
                {action === 'warn' && "They see it under Notices (and as a notification): the rule and your message. It never says who reported them."}
                {action === 'suspend' && "They're signed out on every device and can't sign in until it ends. Their devices keep their chats. They see the reason when they try to sign in."}
                {action === 'unsuspend' && 'They can sign in again straight away.'}
                {action === 'sign_out' && 'For a hijacked account: every sign-in ends and each device wipes its keys and messages. They can sign in again.'}
                {action === 'delete' && 'Removes their profile, devices and what their messages said, and they leave their groups. Shared expenses stay as "Deleted user". This can\'t be undone.'}
              </p>
              {action === 'warn' && (
                <select value={rule} onChange={(e) => setRule(e.target.value as ReportReason)} aria-label="Rule broken"
                  className="w-full h-9 px-2 rounded-lg border border-muted-200 text-sm bg-white">
                  {REPORT_REASONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              )}
              {action === 'suspend' && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="How long">
                  {DURATIONS.map((d) => (
                    <button key={d.label} type="button" onClick={() => setDays(d.days)} aria-pressed={days === d.days}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-lg border ${days === d.days ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-muted-200 text-muted-600'}`}>
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
                placeholder={action === 'suspend' || action === 'warn' ? 'Message (they will see this)' : 'Reason (kept in the admin log)'} aria-label="Reason"
                className="w-full px-3 py-2 rounded-lg border border-muted-200 text-sm outline-none focus:border-primary-500" />
              {action === 'delete' && (
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`Type ${a.username} to confirm`} aria-label="Confirm username"
                  className="w-full h-9 px-3 rounded-lg border border-muted-200 text-sm outline-none focus:border-accent-400" />
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setAction(null)} className="h-9 px-3 rounded-lg text-sm font-semibold text-muted-600 hover:bg-muted-100">Cancel</button>
                <button type="button" onClick={run} disabled={!ready || busy}
                  className={`h-9 px-3 rounded-lg text-sm font-bold text-white disabled:opacity-50 ${action === 'unsuspend' || action === 'sign_out' || action === 'warn' ? 'bg-primary-700 hover:bg-primary-800' : 'bg-accent-600 hover:bg-accent-700'}`}>
                  {busy ? 'Working…' : action === 'warn' ? 'Send warning' : action === 'suspend' ? 'Suspend' : action === 'unsuspend' ? 'Lift suspension' : action === 'sign_out' ? 'Sign out' : 'Delete account'}
                </button>
              </div>
            </div>
          )}

          <ScanControls account={a} onChanged={(scans) => { setA({ ...a, scans }); load(); }} />

          <ProControls account={a} onChanged={load} />

          <Section title={`Devices (${a.devices.length})`}>
            {a.devices.length === 0 ? <Empty text="No linked devices." /> : a.devices.map((d, i) => (
              <li key={i} className="flex justify-between gap-3"><span className="truncate">{d.name}</span><span className="text-muted-500 flex-shrink-0">{when(d.last_seen_at)}</span></li>
            ))}
          </Section>

          <Section title={`Reports against them (${a.reports.length})`}>
            {a.reports.length === 0 ? <Empty text="None." /> : a.reports.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.reason}</span> · {when(r.created_at)} · <span className={r.status === 'open' ? 'text-warning-700' : 'text-muted-500'}>{r.status}</span>
                {r.details && <span className="block text-muted-500">“{r.details}”</span>}
              </li>
            ))}
          </Section>

          <Section title="Admin history">
            {a.admin_actions.length === 0 ? <Empty text="Nothing yet." /> : a.admin_actions.map((x, i) => (
              <li key={i}><span className="font-medium">{ACTION_LABELS[x.action] || x.action}</span> by @{x.by || 'unknown'} · {when(x.at)}
                {x.reason && <span className="block text-muted-500">{x.reason}</span>}</li>
            ))}
          </Section>
        </>
      )}
    </aside>
  );
};

const Fact: React.FC<{ label: string; value: string; wide?: boolean }> = ({ label, value, wide }) => (
  <div className={wide ? 'col-span-2' : ''}>
    <dt className="text-xs text-muted-500">{label}</dt>
    <dd className="text-muted-900 break-words">{value}</dd>
  </div>
);

const ActionButton: React.FC<{ icon: typeof Ban; label: string; danger?: boolean; onClick: () => void }> = ({ icon: Icon, label, danger, onClick }) => (
  <button type="button" onClick={onClick}
    className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm font-semibold border ${
      danger ? 'border-accent-100 bg-accent-50 text-accent-700 hover:bg-accent-100' : 'border-primary-100 bg-primary-50 text-primary-700 hover:bg-primary-100'}`}>
    <Icon size={15} /> {label}
  </button>
);

/** This person's receipt scans: their own monthly limit, or extra scans for this month only. */
const ScanControls: React.FC<{ account: AccountDetails; onChanged: (scans: ScanAllowance) => void }> = ({ account, onChanged }) => {
  const s = account.scans;
  const [mode, setMode] = useState<'limit' | 'extra' | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const paused = s.custom_limit === 0;

  const open = (next: 'limit' | 'extra') => {
    setMode(next);
    setValue(next === 'limit' ? String(s.custom_limit ?? s.app_limit) : '10');
    setReason('');
  };
  const save = async (limit?: number | null) => {
    setBusy(true);
    try {
      const n = Number(value);
      onChanged(mode === 'extra'
        ? await adminService.giveExtraScans(account.id, n, reason.trim())
        : await adminService.setScanLimit(account.id, limit === undefined ? n : limit, reason.trim()));
      toast.success(mode === 'extra' ? `Gave ${n} extra scan${n === 1 ? '' : 's'} this month` : 'Scan limit saved');
      setMode(null);
    } catch (e) {
      toast.error(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(n) && (mode === 'extra' ? n >= 1 && n <= 1000 : n >= 0 && n <= 10000);
  const ready = valid && reason.trim().length >= 3;

  return (
    <section>
      <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-500">Receipt scans this month</h3>
      <p className="text-sm text-muted-900">
        {paused ? <span className="font-semibold text-accent-700">Scanning paused</span> : <><b className="tabular-nums">{s.used}</b> of <b className="tabular-nums">{s.limit}</b> used</>}
      </p>
      <p className="text-xs text-muted-500">
        {s.custom_limit === null ? `App limit (${s.app_limit} a month)` : paused ? `App limit is ${s.app_limit}` : `Own limit: ${s.custom_limit} a month (app limit ${s.app_limit})`}
        {s.extra_this_month > 0 && ` · +${s.extra_this_month} extra this month`}
      </p>
      {!mode && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => open('limit')} className="h-8 px-2.5 rounded-lg text-xs font-semibold border border-primary-100 bg-primary-50 text-primary-700 hover:bg-primary-100">Set monthly limit</button>
          <button type="button" onClick={() => open('extra')} className="h-8 px-2.5 rounded-lg text-xs font-semibold border border-primary-100 bg-primary-50 text-primary-700 hover:bg-primary-100">Give extra scans</button>
        </div>
      )}
      {mode && (
        <div className="mt-2 p-3 rounded-xl border border-muted-200 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-700">{mode === 'limit' ? 'Scans a month' : 'Extra scans this month'}</span>
            <input type="number" min={mode === 'extra' ? 1 : 0} max={mode === 'extra' ? 1000 : 10000} value={value} onChange={(e) => setValue(e.target.value)}
              className="w-24 h-8 px-2 rounded-lg border border-muted-200 text-sm tabular-nums outline-none focus:border-primary-500" />
          </label>
          {mode === 'limit' && <p className="text-xs text-muted-500">0 pauses scanning for this person. Don't lower a paying user's plan mid-month.</p>}
          {mode === 'extra' && <p className="text-xs text-muted-500">They count only until the end of this month.</p>}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (kept in the admin log)" aria-label="Reason" maxLength={500}
            className="w-full h-8 px-2.5 rounded-lg border border-muted-200 text-sm outline-none focus:border-primary-500" />
          <div className="flex flex-wrap justify-end gap-2">
            {mode === 'limit' && s.custom_limit !== null && (
              <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => save(null)}
                className="mr-auto h-8 px-2.5 rounded-lg text-xs font-semibold text-primary-700 hover:bg-primary-50 disabled:opacity-50">Back to app limit</button>
            )}
            <button type="button" onClick={() => setMode(null)} className="h-8 px-2.5 rounded-lg text-xs font-semibold text-muted-600 hover:bg-muted-100">Cancel</button>
            <button type="button" disabled={!ready || busy} onClick={() => save()}
              className="h-8 px-3 rounded-lg text-xs font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </section>
  );
};

const PAYMENT_STATUS: Record<string, string> = {
  paid: 'Paid', failed: 'Failed', mismatch: 'Wrong amount (Pro not given)', refunded: 'Refunded', partially_refunded: 'Partly refunded',
};

/** Pro: until when, what they paid, and giving or ending it (with a reason, logged). Refunds are done in Razorpay. */
const ProControls: React.FC<{ account: AccountDetails; onChanged: () => void }> = ({ account, onChanged }) => {
  const p = account.pro;
  const [mode, setMode] = useState<'grant' | 'end' | null>(null);
  const [days, setDays] = useState('30');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(days);
  const ready = reason.trim().length >= 3 && (mode === 'end' || (Number.isInteger(n) && n >= 1 && n <= 3660));

  const save = async () => {
    if (!mode) return;
    setBusy(true);
    try {
      await adminService.setPro(account.id, mode, reason.trim(), mode === 'grant' ? n : undefined);
      toast.success(mode === 'grant' ? `Gave Pro for ${n} day${n === 1 ? '' : 's'}` : 'Pro ended');
      setMode(null);
      onChanged();
    } catch (e) {
      toast.error(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-500">ShareEven Pro</h3>
      <p className="text-sm text-muted-900">{p.plan === 'pro' ? <>Pro until <b>{when(p.until)}</b></> : 'Free'}</p>
      {!mode && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => { setMode('grant'); setReason(''); }} className="h-8 px-2.5 rounded-lg text-xs font-semibold border border-primary-100 bg-primary-50 text-primary-700 hover:bg-primary-100">{p.plan === 'pro' ? 'Add Pro days' : 'Give Pro'}</button>
          {p.plan === 'pro' && <button type="button" onClick={() => { setMode('end'); setReason(''); }} className="h-8 px-2.5 rounded-lg text-xs font-semibold border border-accent-100 bg-accent-50 text-accent-700 hover:bg-accent-100">End Pro now</button>}
        </div>
      )}
      {mode && (
        <div className="mt-2 p-3 rounded-xl border border-muted-200 space-y-2">
          {mode === 'grant' ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-700">Days of Pro</span>
              <input type="number" min={1} max={3660} value={days} onChange={(e) => setDays(e.target.value)}
                className="w-24 h-8 px-2 rounded-lg border border-muted-200 text-sm tabular-nums outline-none focus:border-primary-500" />
            </label>
          ) : (
            <p className="text-xs text-muted-500">Pro ends now. This doesn't refund anything: refund in the Razorpay dashboard (that also takes back the days it paid for).</p>
          )}
          {mode === 'grant' && <p className="text-xs text-muted-500">Added after their current end date, if they have Pro.</p>}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (kept in the admin log)" aria-label="Reason" maxLength={500}
            className="w-full h-8 px-2.5 rounded-lg border border-muted-200 text-sm outline-none focus:border-primary-500" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMode(null)} className="h-8 px-2.5 rounded-lg text-xs font-semibold text-muted-600 hover:bg-muted-100">Cancel</button>
            <button type="button" disabled={!ready || busy} onClick={save}
              className={`h-8 px-3 rounded-lg text-xs font-bold text-white disabled:opacity-50 ${mode === 'end' ? 'bg-accent-600 hover:bg-accent-700' : 'bg-primary-700 hover:bg-primary-800'}`}>
              {busy ? 'Saving…' : mode === 'end' ? 'End Pro' : 'Give Pro'}</button>
          </div>
        </div>
      )}
      <ul className="mt-2 space-y-1.5 text-sm text-muted-800">
        {p.payments.length === 0 ? <Empty text="No payments." /> : p.payments.map((x) => (
          <li key={x.id}>
            <span className="font-medium tabular-nums">{formatPrice(x.amount, x.currency)}</span> · {x.billing === 'yearly' ? 'a year' : 'a month'} · {when(x.paid_at || x.created_at)} ·{' '}
            <span className={x.status === 'paid' ? 'text-success-600' : x.status === 'failed' || x.status === 'mismatch' ? 'text-accent-700' : 'text-muted-500'}>
              {PAYMENT_STATUS[x.status] || x.status}{x.refunded > 0 && x.status === 'partially_refunded' ? ` (${formatPrice(x.refunded, x.currency)})` : ''}
            </span>
            <span className="block text-xs text-muted-500 break-all">{x.payment_id || x.order_id}{x.error ? ` · ${x.error}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-500">{title}</h3>
    <ul className="space-y-1.5 text-sm text-muted-800">{children}</ul>
  </section>
);

const Empty: React.FC<{ text: string }> = ({ text }) => <li className="text-muted-400">{text}</li>;

// ------------------------------------------------------------------ admin log

const ActivityTab: React.FC<{ onOpenUser: (id: string) => void }> = ({ onOpenUser }) => {
  const [includeViews, setIncludeViews] = useState(false);
  const [actions, setActions] = useState<AdminActionView[] | null>(null);
  useEffect(() => {
    adminService.actions(includeViews).then(setActions).catch((e) => toast.error(parseApiError(e)));
  }, [includeViews]);

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-muted-900">Admin log</h1>
          <p className="text-sm text-muted-500">Everything admins did, newest first.</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-muted-700">
          <input type="checkbox" checked={includeViews} onChange={(e) => setIncludeViews(e.target.checked)} className="accent-primary-700" />
          Include account views
        </label>
      </div>
      {!actions ? <p className="mt-3 text-sm text-muted-400">Loading…</p> : actions.length === 0 ? <p className="mt-3 text-sm text-muted-400">Nothing yet.</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-muted-500">
              <tr><th className="py-2 font-semibold">When</th><th className="py-2 font-semibold">Admin</th><th className="py-2 font-semibold">Action</th>
                <th className="py-2 font-semibold">Account</th><th className="py-2 font-semibold">Reason</th></tr>
            </thead>
            <tbody>
              {actions.map((x) => (
                <tr key={x.id} className="border-t border-muted-100 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-600">{when(x.at)}</td>
                  <td className="py-2 pr-3">@{x.by || 'unknown'}</td>
                  <td className="py-2 pr-3 font-medium text-muted-900 whitespace-nowrap">{ACTION_LABELS[x.action] || x.action}</td>
                  <td className="py-2 pr-3">
                    {x.target ? (
                      <button type="button" onClick={() => onOpenUser(x.target!.id)} className="font-semibold text-primary-700 hover:underline">@{x.target.username || 'deleted'}</button>
                    ) : '—'}
                  </td>
                  <td className="py-2 text-muted-600">{x.reason || (x.action === 'plan_changed' && Array.isArray(x.details?.changed)
                    ? `Changed: ${(x.details!.changed as string[]).map((k) => k.replace(/_/g, ' ')).join(', ') || 'nothing'}` : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AdminPage;
