// src/services/expense.service.ts
import api from '../utils/axios';
import type { CurrencyInfo } from '../utils/money';

const V1 = '/api/v1';

export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares' | 'itemized';

export interface Expense {
  id: string;
  conversation_id: string;
  description: string;
  category: string;
  currency: string;
  total_minor: number;
  total_display: string;
  source: 'manual' | 'receipt';
  split_mode: SplitMode;
  receipt_id: string | null;
  receipt_images: string[];
  created_by: string | null;
  spent_at: string | null;
  locked: boolean;
  deleted: boolean;
  version: number;
  payers: { user_id: string; amount_minor: number }[];
  shares: { user_id: string; amount_minor: number; split_value: string | null }[];
  created_at: string | null;
  updated_at: string | null;
  can_edit?: boolean;
  can_delete?: boolean;
  can_admin?: boolean;
}

export interface ExpenseInput {
  description: string;
  category: string;
  currency: string;
  amount: string;
  spent_at?: string | null;
  split_mode: SplitMode;
  splits: { user_id: string; value?: string | null }[];
  payers?: { user_id: string; amount: string }[] | null;
  version?: number;
}

export interface HistoryEntry {
  id: number;
  action: 'created' | 'updated' | 'deleted' | 'restored' | 'locked' | 'unlocked';
  summary: string;
  actor: { id: string; username: string } | null;
  created_at: string;
}

export interface BalanceUser {
  id: string;
  username: string;
  name?: string | null;
  avatar?: string | null;
  pay?: { revolut?: string; paypal?: string; upi?: string }; // where they can be paid
}

/** Expenses home: your money across every chat. Amounts: + they owe you, - you owe them. */
export interface ExpensesOverview {
  currencies: { currency: string; owed_minor: number; owe_minor: number; net_minor: number }[];
  people: { user_id: string; currency: string; net_minor: number; chats: { conversation_id: string; title: string | null; is_group: boolean; amount_minor: number }[] }[];
  users: Record<string, BalanceUser>;
}

export interface Balances {
  simplified: boolean;
  default_currency: string;
  users: Record<string, BalanceUser>;
  currencies: {
    currency: string;
    my_net_minor: number;
    my_net_display: string;
    nets: { user_id: string; amount_minor: number }[];
    debts: { from_user: string; to_user: string; amount_minor: number; amount_display: string }[];
  }[];
}

/** One member's money in one currency (Expenses → a chat). net > 0: the group owes them. */
export interface MemberMoney {
  user_id: string;
  paid_minor: number;
  share_minor: number;
  sent_minor: number; // payments they recorded making
  received_minor: number;
  net_minor: number;
}

export interface CurrencySummary {
  currency: string;
  total_minor: number;
  total_display: string;
  count: number;
  me: MemberMoney;
  members: MemberMoney[];
  by_category: { category: string; total_minor: number; count: number }[];
  by_month: { month: string; total_minor: number }[]; // "2026-10", newest first
}

export interface ExpenseSummary { currencies: CurrencySummary[]; users: Record<string, BalanceUser> }

export interface Settlement {
  id: string;
  conversation_id: string;
  from_user: string;
  to_user: string;
  currency: string;
  amount_minor: number;
  amount_display: string;
  note: string | null;
  created_by: string | null;
  deleted: boolean;
  created_at: string | null;
}

export type ActivityItem = ({ kind: 'expense'; at: string } & Expense) | ({ kind: 'settlement'; at: string } & Settlement);

export interface ActivityFilters {
  category?: string;
  member?: string;
  date_from?: string;
  date_to?: string;
  kind?: 'expense' | 'settlement';
  include_deleted?: boolean;
}

export interface ExpenseSettings {
  default_currency: string;
  simplify_debts: boolean;
  can_edit: boolean;
}

export interface ReceiptItem {
  id: number;
  name: string;
  raw_text: string | null;
  quantity: string;
  unit: 'each' | 'kg' | 'g' | 'l' | 'ml';
  unit_price_minor: number | null;
  gross_minor: number;
  net_minor: number | null;
  category: string | null;
  flags: string[];
  confidence: number | null;
  split_mode: 'equal' | 'quantity' | 'weight';
  assignments: { user_id: string; value: string }[];
  suggestion: string | null;
}

export interface ReceiptAdjustment {
  id: number;
  kind: string;
  label: string;
  amount_minor: number;
  percent: string | null;
  scope: 'item' | 'group' | 'bill';
  item_indexes: number[];
  allocation: 'proportional' | 'per_unit' | 'equal' | 'assign';
  assignee_ids: string[];
  source: 'printed' | 'store_rule' | 'manual';
  enabled: boolean;
}

export interface ScanStep {
  step: 'ocr' | 'items' | 'photo' | 'second_look' | 'totals';
  label: string;
}

/** One piece of a person's share on a receipt: their part of an item (index into items, after
 * discounts), of an adjustment they were given (index into adjustments), or a cent of rounding. */
export interface SharePart {
  type: 'item' | 'adjustment' | 'rounding';
  id: number | null;
  amount: number;
}

export interface Receipt {
  id: string;
  conversation_id: string;
  uploaded_by: string | null;
  status: 'processing' | 'ready' | 'needs_review' | 'failed' | 'saved';
  progress: ScanStep | null; // while processing: the step it's on
  error: string | null;
  images: string[];
  note: string | null;
  provider: string | null;
  model: string | null;
  key_source: 'app' | 'user' | null;
  store_name: string | null;
  purchased_at: string | null;
  currency: string | null;
  printed_total_minor: number | null;
  prices_include_tax: boolean;
  warnings: string[];
  items: ReceiptItem[];
  adjustments: ReceiptAdjustment[];
  payers: { user_id: string; amount_minor: number }[];
  totals: {
    computed_total_minor: number;
    printed_total_minor: number | null;
    difference_minor: number | null;
    outside_receipt_minor: number;
    unassigned_minor: number;
    unassigned_item_indexes: number[];
    people: { user_id: string; amount_minor: number; breakdown: SharePart[] }[];
  } | null;
  calc_error: string | null;
  expense_id: string | null;
}

export interface ReceiptUpdate {
  store_name: string | null;
  currency: string;
  printed_total: string | null;
  items: {
    id?: number | null;
    name: string;
    quantity: string;
    unit: ReceiptItem['unit'];
    price: string;
    category: string | null;
    flags: string[];
    split_mode: ReceiptItem['split_mode'];
    assignments: { user_id: string; value: string }[];
  }[];
  adjustments: {
    kind: string;
    label: string;
    amount: string | null;
    percent: string | null;
    item_indexes: number[];
    allocation: ReceiptAdjustment['allocation'];
    assignee_ids: string[];
    source: ReceiptAdjustment['source'];
    enabled: boolean;
  }[];
  payers: { user_id: string; amount: string }[] | null;
}

export interface AIModelOption {
  id: number;
  provider: 'anthropic' | 'openai';
  model_id: string;
  label: string;
  description: string;
  is_default: boolean;
  available?: boolean;
  enabled?: boolean;
  sort_order?: number;
}

/** Receipt scans this month; ShareEven picks the model (admin console), people don't. */
export interface AISettings {
  usage: { scans_this_month: number; monthly_limit: number };
}

export interface StoreDiscount {
  id: number;
  store_name: string;
  percent: string;
  excluded_categories: string[];
  stacks_with_reduced: boolean;
  active: boolean;
}

export interface AdminAI {
  models: AIModelOption[];
  receipt_scans_per_month: number;
  app_keys: { anthropic: boolean; openai: boolean };
}

const data = <T>(promise: Promise<{ data: { data: T } }>) => promise.then(r => r.data.data);

export const expenseService = {
  currencies: () => data<CurrencyInfo[]>(api.get(`${V1}/currencies`)),
  /** Units of each currency per 1 `base` (for showing totals in someone's chosen currency). */
  exchangeRates: (base: string) =>
    data<{ base: string; rates: Record<string, number>; updated: string | null; source: string }>(api.get(`${V1}/exchange-rates`, { params: { base } })),
  /** Newest expenses and payments across every chat (Expenses home). */
  recentActivity: (limit = 30) =>
    data<{ items: ActivityItem[]; users: Record<string, BalanceUser>; chats: Record<string, { name: string; is_group: boolean }> }>(
      api.get(`${V1}/expenses/activity`, { params: { limit } })),

  /** Ids of your chats that have expenses */
  conversationsWithExpenses: () => data<string[]>(api.get(`${V1}/expenses/conversations`)),
  list: (conversationId: string, includeDeleted = false) =>
    data<Expense[]>(api.get(`${V1}/conversations/${conversationId}/expenses`, { params: { include_deleted: includeDeleted } })),
  get: (id: string) => data<Expense>(api.get(`${V1}/expenses/${id}`)),
  create: (conversationId: string, body: ExpenseInput) => data<Expense>(api.post(`${V1}/conversations/${conversationId}/expenses`, body)),
  update: (id: string, body: ExpenseInput) => data<Expense>(api.put(`${V1}/expenses/${id}`, body)),
  remove: (id: string) => data<Expense>(api.delete(`${V1}/expenses/${id}`)),
  restore: (id: string) => data<Expense>(api.post(`${V1}/expenses/${id}/restore`)),
  lock: (id: string, locked: boolean) => data<Expense>(api.put(`${V1}/expenses/${id}/lock`, { locked })),
  history: (id: string) => data<HistoryEntry[]>(api.get(`${V1}/expenses/${id}/history`)),

  balances: (conversationId: string) => data<Balances>(api.get(`${V1}/conversations/${conversationId}/balances`)),
  overview: () => data<ExpensesOverview>(api.get(`${V1}/expenses/overview`)),
  /** Nudge someone who owes you in this chat (once a day). */
  remind: (conversationId: string, userId: string, currency: string) =>
    data(api.post(`${V1}/conversations/${conversationId}/remind`, { user_id: userId, currency })),
  /** Totals, everyone's balance, and spending by category and month. */
  summary: (conversationId: string) => data<ExpenseSummary>(api.get(`${V1}/conversations/${conversationId}/expenses/summary`)),
  /** Expenses and payments in one timeline, newest first. */
  activity: (conversationId: string, filters: ActivityFilters = {}) =>
    data<{ items: ActivityItem[]; users: Record<string, BalanceUser> }>(api.get(`${V1}/conversations/${conversationId}/history`, { params: filters })),
  removeSettlement: (id: string) => data(api.delete(`${V1}/settlements/${id}`)),
  /** Fix a recorded payment's amount or note. */
  updateSettlement: (id: string, body: { amount: string; note?: string | null }) => data(api.patch(`${V1}/settlements/${id}`, body)),
  /** The chat's expenses as an Excel file (summary, expenses, discounted products), saved by the browser. */
  downloadExcel: async (conversationId: string) => {
    const res = await api.get(`${V1}/conversations/${conversationId}/expenses/export`, { responseType: 'blob' });
    const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || 'expenses.xlsx';
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  settle: (conversationId: string, body: { from_user: string; to_user: string; currency: string; amount: string; note?: string }) =>
    data(api.post(`${V1}/conversations/${conversationId}/settlements`, body)),
  settings: (conversationId: string) => data<ExpenseSettings>(api.get(`${V1}/conversations/${conversationId}/expense-settings`)),
  updateSettings: (conversationId: string, body: Partial<Omit<ExpenseSettings, 'can_edit'>>) =>
    data<ExpenseSettings>(api.put(`${V1}/conversations/${conversationId}/expense-settings`, body)),

  scanReceipt: (conversationId: string, imageUrls: string[], note?: string) =>
    data<Receipt>(api.post(`${V1}/conversations/${conversationId}/receipts`, { image_urls: imageUrls, note: note || null })),
  openReceipts: (conversationId: string) =>
    data<{ id: string; status: Receipt['status']; store_name: string | null; uploaded_by: string | null; images: string[]; created_at: string }[]>(
      api.get(`${V1}/conversations/${conversationId}/receipts`)),
  getReceipt: (id: string) => data<Receipt>(api.get(`${V1}/receipts/${id}`)),
  updateReceipt: (id: string, body: ReceiptUpdate) => data<Receipt>(api.put(`${V1}/receipts/${id}`, body)),
  retryReceipt: (id: string) => data<Receipt>(api.post(`${V1}/receipts/${id}/retry`)),
  discardReceipt: (id: string) => data(api.delete(`${V1}/receipts/${id}`)),
  saveReceipt: (id: string, body: { description?: string; category?: string }) =>
    data<Expense>(api.post(`${V1}/receipts/${id}/save`, body)),

  aiSettings: () => data<AISettings>(api.get(`${V1}/ai/settings`)),

  storeDiscounts: () => data<StoreDiscount[]>(api.get(`${V1}/store-discounts`)),
  saveStoreDiscount: (body: Omit<StoreDiscount, 'id'>, id?: number) =>
    data<StoreDiscount>(id ? api.put(`${V1}/store-discounts/${id}`, body) : api.post(`${V1}/store-discounts`, body)),
  deleteStoreDiscount: (id: number) => data(api.delete(`${V1}/store-discounts/${id}`)),

  admin: () => data<AdminAI>(api.get(`${V1}/admin/ai`)),
  adminSaveModel: (body: Omit<AIModelOption, 'id' | 'available'>, id?: number) =>
    data<AdminAI>(id ? api.put(`${V1}/admin/ai/models/${id}`, body) : api.post(`${V1}/admin/ai/models`, body)),
  adminScanLimit: (receipt_scans_per_month: number) => data<AdminAI>(api.put(`${V1}/admin/ai/scan-limit`, { receipt_scans_per_month })),
};

export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'groceries', label: 'Groceries' },
  { id: 'food', label: 'Eating out' },
  { id: 'drinks', label: 'Drinks' },
  { id: 'transport', label: 'Transport' },
  { id: 'travel', label: 'Travel' },
  { id: 'rent', label: 'Rent' },
  { id: 'utilities', label: 'Bills' },
  { id: 'household', label: 'Household' },
  { id: 'entertainment', label: 'Fun' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'health', label: 'Health' },
  { id: 'gifts', label: 'Gifts' },
  { id: 'other', label: 'Other' },
];
