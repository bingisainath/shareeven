// src/pages/Settings/index.tsx
// Settings (Figma design): /settings is the profile card (opens Account) and one list. Notifications and
// currency are set right in the list; every other row opens its own page at /settings/<section> with a
// back arrow. Same structure as the Android app.

import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft, Ban, Bell, ChevronRight, Inbox, Coins, FileText, HelpCircle, Info, KeyRound, LayoutDashboard, LifeBuoy,
  LockKeyhole, LogOut, MonitorSmartphone, ReceiptText, ShieldCheck, Sparkles, Store, UserRound,
} from 'lucide-react';
import { Avatar } from '../../components/atoms';
import { StoreDiscountSettings } from '../../components/expenses/ExpenseSettingsSections';
import SessionsSettings from '../../components/organisms/SessionsSettings';
import EncryptionSettings from '../../components/organisms/EncryptionSettings';
import BackupSettings from '../../components/organisms/BackupSettings';
import AccountDataSettings from '../../components/organisms/AccountDataSettings';
import { BlockedPeopleSettings } from '../../components/organisms/SafetySettings';
import { ContactSupport } from '../../components/organisms/SupportSettings';
import { NoticesSection } from '../../components/organisms/Notices';
import PlanSettings from '../../components/organisms/PlanSettings';
import { loadPlan } from '../../services/billing.service';
import { useNotices } from '../../hooks/useNotices';
import { expenseService } from '../../services/expense.service';
import type { AISettings } from '../../services/expense.service';
import { getNotificationStatus, setNotificationsEnabled } from '../../utils/notifications';
import type { NotificationStatus } from '../../utils/notifications';
import { parseApiError } from '../../utils/apiError';
import { toast } from 'react-toastify';
import { useAuth } from '../../app/AuthProvider';
import type { CurrencyInfo } from '../../utils/money';

type Badge = { text: string; tone: 'good' | 'off' | 'tint' | 'warn' };
const BADGE: Record<Badge['tone'], string> = {
  good: 'bg-[#eaf7ee] text-success-600',
  off: 'bg-muted-100 text-muted-500',
  tint: 'bg-primary-100 text-primary-700',
  warn: 'bg-warning-50 text-warning-700',
};

interface Section {
  slug: string;
  icon: LucideIcon;
  label: string;
  hint: string;
}

const SECTIONS: Section[] = [
  { slug: 'account', icon: UserRound, label: 'Account', hint: 'Profile, username and payment details' }, // opened from the profile card
  { slug: 'backup', icon: KeyRound, label: 'Encryption & backup', hint: 'Recovery key and secure backups' },
  { slug: 'devices', icon: MonitorSmartphone, label: 'Linked devices', hint: "Link a phone or browser, see where you're signed in" },
  { slug: 'plan', icon: Sparkles, label: 'ShareEven Pro', hint: 'More receipt scans; plans and payment' },
  { slug: 'receipts', icon: ReceiptText, label: 'Receipt scanning', hint: 'Your monthly scans' },
  { slug: 'discounts', icon: Store, label: 'Store discounts', hint: 'Your personal store offers' },
  { slug: 'blocked', icon: Ban, label: 'Blocked people', hint: "People who can't message you" },
  { slug: 'notices', icon: Inbox, label: 'Notices', hint: 'Messages from the ShareEven team' },
  { slug: 'support', icon: LifeBuoy, label: 'Contact support', hint: 'Report a problem or ask us anything; see our replies' },
  { slug: 'help', icon: HelpCircle, label: 'Help & about', hint: 'FAQ, contact us, terms and privacy' },
];

const card = 'bg-white border border-muted-200 rounded-[17px] shadow-[0_3px_14px_rgba(26,20,37,0.035)]';

const RowInner: React.FC<{ icon: LucideIcon; label: string; hint?: string; badge?: Badge; danger?: boolean; arrow?: boolean }> = ({
  icon: Icon, label, hint, badge, danger, arrow = true,
}) => (
  <>
    <span className={`grid place-items-center w-10 h-10 flex-shrink-0 rounded-[11px] ${danger ? 'bg-accent-50 text-accent-700' : 'bg-primary-50 text-primary-700'}`}>
      <Icon className="w-5 h-5" />
    </span>
    <span className="flex-1 min-w-0 grid gap-[3px]">
      <strong className={`text-sm font-bold truncate ${danger ? 'text-accent-700' : 'text-muted-900'}`}>{label}</strong>
      {hint && <small className="text-xs text-muted-500">{hint}</small>}
    </span>
    {badge && <b className={`flex-shrink-0 text-[10px] font-bold px-2 py-[5px] rounded-[10px] ${BADGE[badge.tone]}`}>{badge.text}</b>}
    {arrow && <ChevronRight className="w-4 h-4 flex-shrink-0 text-muted-400" />}
  </>
);

const rowClass = 'w-full flex items-center gap-3 text-left px-4 sm:px-[18px] py-3.5 border-t border-muted-200 first:border-t-0 hover:bg-primary-50 transition-colors';

// ------------------------------------------------------------------ pages

/** Notifications, switched right in the list. */
const NotificationsRow: React.FC = () => {
  const [status, setStatus] = useState<NotificationStatus>(getNotificationStatus);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      setStatus(await setNotificationsEnabled(status !== 'on'));
    } finally {
      setBusy(false);
    }
  };
  const hint: Record<NotificationStatus, string> = {
    on: 'Desktop notifications for new messages',
    off: 'Desktop notifications for new messages',
    denied: "Blocked for this site: allow them in your browser's site settings, then reload",
    unsupported: "This browser doesn't support notifications",
  };
  const canSwitch = status === 'on' || status === 'off';
  return (
    <div className={`${rowClass} hover:bg-transparent`}>
      <RowInner icon={Bell} label="Notifications" hint={hint[status]} arrow={false}
        badge={canSwitch ? undefined : { text: status === 'denied' ? 'Blocked' : 'Not available', tone: 'off' }} />
      {canSwitch && (
        <button role="switch" aria-checked={status === 'on'} aria-label="Notifications" onClick={toggle} disabled={busy}
          className={`relative flex-shrink-0 w-12 h-7 rounded-full transition-colors disabled:opacity-50 ${status === 'on' ? 'bg-primary-600' : 'bg-muted-300'}`}>
          <span className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${status === 'on' ? 'translate-x-5' : ''}`} />
        </button>
      )}
    </div>
  );
};

/** "Show totals in", picked right in the list: amounts in other currencies also show converted (≈). */
const CurrencyRow: React.FC = () => {
  const { user, updateProfile } = useAuth();
  const [codes, setCodes] = useState<CurrencyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { expenseService.currencies().then(setCodes).catch(() => undefined); }, []);
  const choose = async (code: string) => {
    setBusy(true);
    try {
      await updateProfile({ display_currency: code });
      toast.success(code ? `Totals will also show in ${code}` : 'Showing original currencies only');
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${rowClass} hover:bg-transparent`}>
      <RowInner icon={Coins} label="Currency" hint="Also show amounts converted at today's rate" arrow={false} />
      <select value={user?.display_currency || ''} onChange={(e) => choose(e.target.value)} disabled={busy} aria-label="Show totals in"
        className="flex-shrink-0 w-[7.5rem] sm:w-48 h-9 px-2 rounded-[11px] border border-muted-200 bg-white text-xs font-semibold text-muted-900 disabled:opacity-60">
        <option value="">Off</option>
        {codes.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
      </select>
    </div>
  );
};

const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString([], { day: 'numeric', month: 'long' });
};

const ReceiptsSection: React.FC = () => {
  const [usage, setUsage] = useState<AISettings['usage'] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    expenseService.aiSettings().then((s) => setUsage(s.usage)).catch((e) => setError(parseApiError(e)));
  }, []);
  const limit = usage?.monthly_limit ?? 0;
  const used = usage?.scans_this_month ?? 0;
  const left = Math.max(0, limit - used);
  return (
    <div className="space-y-[18px]">
      {error && <p role="alert" className="text-sm text-accent-700">{error}</p>}
      <div className={`${card} p-[18px] sm:p-6`}>
        {!usage ? <p className="text-sm text-muted-500">Loading…</p> : (
          <>
            <div className="flex items-center gap-3">
              <span className="grid place-items-center w-10 h-10 rounded-[11px] bg-primary-50 text-primary-700"><ReceiptText className="w-5 h-5" /></span>
              <div>
                <p className="font-display text-[26px] font-bold tracking-tight text-muted-900">{left} <span className="text-sm font-semibold tracking-normal text-muted-500">of {limit} scans left</span></p>
                <p className="text-xs text-muted-500">{limit === 0 ? 'Receipt scanning is paused for your account.' : `This month. Resets on ${nextMonth()}.`}</p>
              </div>
            </div>
            <div className="mt-4 h-2 rounded bg-primary-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="Scans used">
              <div className={`h-2 rounded ${left === 0 ? 'bg-warning-700' : 'bg-primary-700'}`} style={{ width: `${limit > 0 ? Math.min(100, (used / limit) * 100) : 100}%` }} />
            </div>
            <p className="mt-1.5 text-right text-[11px] text-muted-500">{used} used</p>
          </>
        )}
      </div>
      {usage && left <= 3 && (
        <Link to="/settings/plan" className="flex items-center justify-center gap-2 h-11 rounded-[13px] bg-primary-50 border border-primary-100 text-sm font-bold text-primary-700 hover:bg-primary-100 transition-colors">
          <Sparkles className="w-4 h-4" /> Get more scans with Pro
        </Link>
      )}
      <Note icon={Sparkles} title="How it works"
        text="In a chat, tap Add expense and scan a receipt. ShareEven reads the items and prices so you can split them; you check everything before saving. Each receipt counts as one scan; scans that fail don't count." />
    </div>
  );
};

const Note: React.FC<{ icon: LucideIcon; title: string; text: string }> = ({ icon: Icon, title, text }) => (
  <div className="flex items-start gap-[13px] px-5 py-4 rounded-[15px] bg-primary-100 text-primary-700">
    <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
    <div className="grid gap-[3px]">
      <strong className="text-sm">{title}</strong>
      <span className="text-xs leading-relaxed">{text}</span>
    </div>
  </div>
);

const PAY_NAMES: Record<string, string> = { revolut: 'Revolut', paypal: 'PayPal', upi: 'UPI' };

const ProfileCard: React.FC<{ user: any; onEditProfile?: () => void; to?: string }> = ({ user, onEditProfile, to }) => {
  const username = user.username || user.email.split('@')[0];
  const body = (
    <>
      <Avatar src={user.avatar} alt={user.name || username} size="xl" />
      <div className="flex-1 min-w-0">
        <h2 className="font-display text-xl font-bold text-muted-900 truncate">{user.name || username}</h2>
        <p className="mt-[5px] text-xs text-muted-500 break-words">@{username} · {user.email}</p>
        {user.bio && <p className="mt-[5px] text-xs text-muted-500">{user.bio}</p>}
      </div>
    </>
  );
  const cls = `${card} p-[18px] sm:p-6 flex items-start sm:items-center gap-[18px]`;
  if (to) {
    return <Link to={to} className={`${cls} hover:bg-primary-50 transition-colors`} aria-label="Account">{body}<ChevronRight className="w-4 h-4 flex-shrink-0 self-center text-muted-400" /></Link>;
  }
  return (
    <section className={cls} aria-label="Profile">
      {body}
      {onEditProfile && (
        <button onClick={onEditProfile} className="flex-shrink-0 h-10 px-4 text-xs font-bold text-primary-700 bg-primary-50 border border-primary-100 hover:bg-primary-100 rounded-[11px]">
          Edit profile
        </button>
      )}
    </section>
  );
};

const AccountSection: React.FC<{ user: any; onEditProfile: () => void }> = ({ user, onEditProfile }) => {
  const payTo = Object.keys(PAY_NAMES).filter((k) => user.payment_handles?.[k]);
  return (
    <div className="space-y-[18px]">
      <ProfileCard user={user} onEditProfile={onEditProfile} />
      <div className={`${card} p-4 sm:p-6 text-sm`}>
        <h2 className="text-base font-bold text-muted-900">Payment details</h2>
        <p className="mt-1 text-muted-500">
          {payTo.length > 0
            ? `People who owe you can pay via ${payTo.map((k) => PAY_NAMES[k]).join(', ')}. Change them in Edit profile.`
            : 'Optional. Add Revolut, PayPal or UPI in Edit profile and people who owe you see a Pay button. ShareEven never moves money.'}
        </p>
        <p className="mt-3 text-xs text-muted-400">Joined {new Date(user.created_at).toLocaleDateString()}</p>
      </div>
      <AccountDataSettings />
    </div>
  );
};

const HelpSection: React.FC = () => (
  <div className={`${card} overflow-hidden`}>
    {([
      ['faq', HelpCircle, 'FAQ', 'Common questions about chats, expenses and encryption'],
      ['contact', LifeBuoy, 'Contact us', 'Support, privacy and security'],
      ['about', Info, 'About ShareEven', undefined],
      ['terms', FileText, 'Terms of Service', undefined],
      ['privacy', LockKeyhole, 'Privacy Policy', undefined],
    ] as [string, LucideIcon, string, string | undefined][]).map(([slug, icon, label, hint]) => (
      <Link key={slug} to={`/${slug}`} className={rowClass}><RowInner icon={icon} label={label} hint={hint} /></Link>
    ))}
  </div>
);

// ------------------------------------------------------------------ the page

const SettingsPage: React.FC<{ user: any; onEditProfile: () => void; onLogout: () => void }> = ({ user, onEditProfile, onLogout }) => {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [pro, setPro] = useState(false);
  const unreadNotices = useNotices().unread;

  useEffect(() => {
    if (section) return;
    loadPlan().then((p) => setPro(p.current.plan === 'pro')).catch(() => undefined);
    expenseService.aiSettings()
      .then(({ usage }) => setScansLeft(Math.max(0, usage.monthly_limit - usage.scans_this_month)))
      .catch(() => setScansLeft(null));
  }, [section]);

  const current = SECTIONS.find((s) => s.slug === section);

  if (section && current) {
    return (
      <div className="px-4 py-[22px] sm:p-8 h-full overflow-auto">
        <div className="max-w-[850px] mx-auto">
          <button onClick={() => navigate('/settings')} className="inline-flex items-center gap-1.5 -ml-1 px-1 py-1 text-sm font-bold text-primary-700 hover:underline">
            <ArrowLeft className="w-4 h-4" /> Settings
          </button>
          <h1 className="mt-2 mb-5 font-display text-[28px] font-bold tracking-[-0.04em] text-muted-900">{current.label}</h1>
          <div className="space-y-[18px]">
            {section === 'account' && <AccountSection user={user} onEditProfile={onEditProfile} />}
            {section === 'backup' && (
              <>
                <Note icon={ShieldCheck} title="End-to-end encryption is on"
                  text="Messages, photos, videos, voice messages and files are encrypted on your devices. Expenses, receipt scans and group names and photos aren't: the server needs them to work out balances and show your chats." />
                <BackupSettings userId={user.id} />
              </>
            )}
            {section === 'devices' && (<><EncryptionSettings /><SessionsSettings /></>)}
            {section === 'plan' && <PlanSettings />}
            {section === 'receipts' && <ReceiptsSection />}
            {section === 'discounts' && <StoreDiscountSettings />}
            {section === 'blocked' && <BlockedPeopleSettings />}
            {section === 'notices' && <NoticesSection />}
            {section === 'support' && <ContactSupport />}
            {section === 'help' && <HelpSection />}
          </div>
        </div>
      </div>
    );
  }

  const badges: Record<string, Badge | undefined> = {
    plan: pro ? { text: 'Pro', tone: 'good' } : { text: 'Free', tone: 'off' },
    notices: unreadNotices ? { text: `${unreadNotices} new`, tone: 'warn' } : undefined,
    receipts: scansLeft === null ? undefined : { text: `${scansLeft} scans left`, tone: scansLeft > 0 ? 'good' : 'warn' },
  };
  const link = (slug: string) => {
    const it = SECTIONS.find((x) => x.slug === slug)!;
    return (
      <Link key={slug} to={`/settings/${slug}`} className={rowClass}>
        <RowInner icon={it.icon} label={it.label} hint={it.hint} badge={badges[slug]} />
      </Link>
    );
  };

  return (
    <div className="px-4 py-[22px] sm:p-8 h-full overflow-auto">
      <div className="max-w-[850px] mx-auto">
        <header className="mb-5 sm:mb-7">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary-500">Personalise ShareEven</p>
          <h1 className="mt-[3px] mb-[5px] font-display text-[28px] sm:text-[32px] font-bold tracking-[-0.04em] text-muted-900">Settings</h1>
          <p className="text-xs sm:text-sm text-muted-500">Privacy, account and app preferences.</p>
        </header>

        <ProfileCard user={user} to="/settings/account" />

        <nav aria-label="Settings" className={`${card} mt-[18px] overflow-hidden`}>
          {link('plan')}
          {link('backup')}
          {link('devices')}
          <NotificationsRow />
          {link('receipts')}
          {link('discounts')}
          <CurrencyRow />
          {link('blocked')}
          {link('notices')}
          {link('support')}
          {link('help')}
          {user.is_app_admin && (
            <Link to="/admin" className={rowClass}>
              <RowInner icon={LayoutDashboard} label="Admin console" hint="Overview, people, reports and the admin log. Only app admins see this." />
            </Link>
          )}
        </nav>

        <Link to="/settings/backup" className="mt-[18px] flex items-center gap-[13px] px-5 py-4 rounded-[15px] bg-primary-100 text-primary-700 hover:bg-primary-200/60 transition-colors">
          <ShieldCheck className="w-5 h-5 flex-shrink-0" />
          <span className="flex-1 grid gap-[3px]">
            <strong className="text-sm">Your privacy is protected</strong>
            <span className="text-[11px]">Messages and expense details are end-to-end encrypted.</span>
          </span>
        </Link>

        <div className={`${card} mt-[18px] mb-4 overflow-hidden`}>
          <button onClick={onLogout} className={rowClass}>
            <RowInner icon={LogOut} label="Log out" hint="Sign out of ShareEven on this device" danger arrow={false} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
