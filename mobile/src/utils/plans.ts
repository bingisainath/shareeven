// src/utils/plans.ts (same as web/src/utils/plans.ts: keep in sync)
// ShareEven Pro: what it costs, what it gives and who takes the payment. App admins set all of it in
// the admin console (Admin → Pro & payments); the Plan page gets it from GET /billing/plan and falls
// back to DEFAULT_PRO (the server's own default) when that can't be loaded.
//
// Pro is paid for a month or a year at a time and doesn't renew by itself (one-off payments are
// the simplest for UPI and cards: no mandates to set up or cancel). We remind people before it ends.

export type Billing = 'monthly' | 'yearly';
export type Provider = 'razorpay' | 'card';

export interface ProPlan {
  /** Off: the plans are shown but the button says payments aren't open yet. */
  payments_enabled: boolean;
  scans_per_month: number;
  /** Minor units (paise, cents), taxes included. */
  prices: Record<string, Record<Billing, number>>;
  features: string[];
  providers: { razorpay: boolean; card: boolean; razorpay_currencies: string[] };
}

export const DEFAULT_PRO: ProPlan = {
  payments_enabled: false,
  scans_per_month: 100,
  prices: {
    INR: { monthly: 9900, yearly: 99900 },
    EUR: { monthly: 299, yearly: 2999 },
    USD: { monthly: 299, yearly: 2999 },
    GBP: { monthly: 249, yearly: 2499 },
  },
  features: [
    '100 receipt scans a month',
    'Everything in Free',
    'Helps keep ShareEven independent, ad-free and end-to-end encrypted',
  ],
  providers: { razorpay: true, card: true, razorpay_currencies: ['INR'] },
};

export const freeFeatures = (scansPerMonth: number | null) => [
  scansPerMonth === null ? 'Receipt scans every month' : `${scansPerMonth} receipt scans a month`,
  'Unlimited chats, groups and expenses',
  'End-to-end encrypted messages, photos and files',
  'Balances, settle up and Excel export',
];

/**
 * The currency to charge in: the person's display currency when Pro has a price in it; else INR in
 * India; elsewhere EUR, then USD, then any other priced currency (rupees only as a last resort).
 */
export function planCurrency(plan: ProPlan, displayCurrency?: string | null, locale?: string): string {
  const c = displayCurrency?.toUpperCase();
  if (c && plan.prices[c]) return c;
  const priced = Object.keys(plan.prices);
  const order = /[-_]IN\b/i.test(locale || '') ? ['INR', 'USD', 'EUR'] : ['EUR', 'USD', ...priced.filter((x) => x !== 'INR')];
  return order.find((x) => plan.prices[x]) || priced[0];
}

export interface ProviderOption {
  id: Provider;
  label: string;
  methods: string;
}

/** Who can take a payment in this currency, best first (as turned on by admins). */
export function providersFor(plan: ProPlan, currency: string): ProviderOption[] {
  const out: ProviderOption[] = [];
  if (plan.providers.razorpay && plan.providers.razorpay_currencies.includes(currency)) {
    out.push({ id: 'razorpay', label: 'Razorpay', methods: currency === 'INR' ? 'UPI, cards, net banking and wallets' : 'Cards and wallets' });
  }
  if (plan.providers.card) out.push({ id: 'card', label: 'Credit or debit card', methods: 'Visa, Mastercard, Amex and more' });
  return out;
}

/** 99900 INR -> "₹999", 2999 EUR -> "€29.99": no ".00" on whole amounts. */
export function formatPrice(minor: number, currency: string): string {
  const major = minor / 100;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${whole ? major : major.toFixed(2)} ${currency}`;
  }
}

/** How much cheaper a year is than twelve months, in whole percent (0 when it isn't). */
export function yearlySaving(plan: ProPlan, currency: string): number {
  const p = plan.prices[currency];
  if (!p) return 0;
  return Math.max(0, Math.round((1 - p.yearly / (p.monthly * 12)) * 100));
}

export const pricePer = (billing: Billing) => (billing === 'monthly' ? 'month' : 'year');

/** A yearly price per month, for "₹125 a month": whole units when the year is a whole amount. */
export const perMonth = (yearlyMinor: number) =>
  yearlyMinor % 100 === 0 ? Math.round(yearlyMinor / 1200) * 100 : Math.round(yearlyMinor / 12);
