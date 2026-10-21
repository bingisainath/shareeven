// src/services/admin.service.ts
// The admin console (app admins only): overview numbers, accounts, suspension and the action log.
import api from '../utils/axios';

const V1 = '/api/v1/admin';
const data = <T>(promise: Promise<{ data: { data: T } }>) => promise.then(r => r.data.data);

export interface DayCount { day: string; count: number }

export interface Overview {
  days: number;
  totals: { users: number; suspended: number; active_today: number; active_7_days: number; active_30_days: number; open_reports: number };
  series: { signups: DayCount[]; messages: DayCount[]; expenses: DayCount[]; receipt_scans: DayCount[] };
  receipt_models: { model: string; key: string; scans: number; input_tokens: number; output_tokens: number }[];
}

export interface Suspension { since: string; until: string | null; reason: string | null }

export interface AccountSummary {
  id: string;
  username: string;
  name: string | null;
  email: string;
  avatar: string | null;
  created_at: string;
  last_active: string | null;
  is_app_admin: boolean;
  deleted: boolean;
  suspension: Suspension | null;
  reports_against: number;
  /** Set while they have Pro: when it ends. */
  pro_until: string | null;
}

export interface AdminActionView {
  id?: string;
  action: string;
  reason: string | null;
  details: Record<string, unknown> | null;
  at: string;
  by: string | null;
  target?: { id: string; username: string | null } | null;
}

export interface AccountDetails extends AccountSummary {
  email_verified: boolean;
  last_login: string | null;
  counts: {
    direct_chats: number; groups: number; messages_sent: number; expenses_added: number; receipts_scanned: number;
    signed_in_sessions: number; blocked_by: number; reports_made: number; warnings: number;
  };
  scans: ScanAllowance;
  pro: ProStatus & { payments: PaymentView[] };
  devices: { name: string; added_at: string | null; last_seen_at: string | null }[];
  reports: { id: string; reason: string; details: string | null; status: string; created_at: string }[];
  admin_actions: AdminActionView[];
}

/** Receipt scans this month: limit = (custom_limit ?? app_limit) + extra_this_month. */
export interface ScanAllowance {
  used: number;
  limit: number;
  app_limit: number;
  custom_limit: number | null; // 0 = scanning paused
  extra_this_month: number;
}

export interface ProStatus { plan: 'free' | 'pro'; until?: string }

export interface PaymentView {
  id: string;
  provider: string;
  order_id: string;
  payment_id: string | null;
  billing: 'monthly' | 'yearly';
  currency: string;
  amount: number;
  refunded: number;
  /** paid | failed | mismatch (paid the wrong amount: never turned Pro on) | refunded | partially_refunded */
  status: string;
  error: string | null;
  pro_from: string | null;
  pro_until: string | null;
  created_at: string;
  paid_at: string | null;
}

export type AccountFilter = 'all' | 'suspended' | 'reported' | 'admins';

export const adminService = {
  overview: (days: number) => data<Overview>(api.get(`${V1}/overview`, { params: { days } })),
  users: (q: string, show: AccountFilter, offset = 0) =>
    data<{ users: AccountSummary[]; more: boolean }>(api.get(`${V1}/users`, { params: { q, show, offset } })),
  user: (id: string) => data<AccountDetails>(api.get(`${V1}/users/${id}`)),
  suspend: (id: string, reason: string, days: number | null) => data(api.post(`${V1}/users/${id}/suspend`, { reason, days })),
  unsuspend: (id: string, reason: string) => data(api.post(`${V1}/users/${id}/unsuspend`, { reason })),
  signOut: (id: string, reason: string) => data<{ sessions: number }>(api.post(`${V1}/users/${id}/sign-out`, { reason })),
  remove: (id: string, reason: string, confirmUsername: string) =>
    data(api.post(`${V1}/users/${id}/delete`, { reason, confirm_username: confirmUsername })),
  setScanLimit: (id: string, limit: number | null, reason: string) =>
    data<ScanAllowance>(api.post(`${V1}/users/${id}/scan-limit`, { limit, reason })),
  giveExtraScans: (id: string, count: number, reason: string) =>
    data<ScanAllowance>(api.post(`${V1}/users/${id}/extra-scans`, { count, reason })),
  setPro: (id: string, action: 'grant' | 'end', reason: string, days?: number) =>
    data<ProStatus & { scans: ScanAllowance }>(api.post(`${V1}/users/${id}/pro`, { action, reason, days })),
  actions: (includeViews: boolean) => data<AdminActionView[]>(api.get(`${V1}/actions`, { params: { include_views: includeViews } })),
};
