// src/services/billing.service.ts (the phone doesn't sell Pro: see mobile/src/api/billing.ts)
// Paying for ShareEven Pro. The Plan page only calls the two functions below.
//
//   1. POST /billing/checkout { billing, currency } -> the server makes a Razorpay order for the price
//      admins set (never one from here) and returns what checkout.js needs.
//   2. Razorpay's checkout (loaded from checkout.razorpay.com) takes the payment.
//   3. POST /billing/verify with what checkout hands back: the server checks its signature and asks
//      Razorpay, then turns Pro on. Razorpay's webhook does the same if this page is closed first,
//      so the app never decides that itself.
import api from '../utils/axios';
import { parseApiError } from '../utils/apiError';
import { DEFAULT_PRO } from '../utils/plans';
import type { Billing, ProPlan, Provider } from '../utils/plans';

export interface CheckoutRequest {
  billing: Billing;
  currency: string;
  provider: Provider;
}

export type CheckoutResult =
  | { status: 'paid'; current: CurrentPlan }
  | { status: 'cancelled' }
  /** Paid, but not confirmed yet: Pro turns on when Razorpay tells the server (a few minutes). */
  | { status: 'pending'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'unavailable'; message: string };

export interface CurrentPlan {
  plan: 'free' | 'pro';
  /** Pro: when it ends (ISO date and time). */
  until?: string;
}

interface RazorpayOrder {
  key_id: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name?: string; email?: string };
}

interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (r: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

export const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptLoading: Promise<void> | null = null;

/** Razorpay's checkout script, added to the page the first time someone pays. */
export function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!scriptLoading) {
    scriptLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CHECKOUT_SCRIPT;
      script.async = true;
      script.onload = () => (window.Razorpay ? resolve() : reject(new Error('Razorpay checkout did not load')));
      script.onerror = () => { script.remove(); reject(new Error('Razorpay checkout did not load')); };
      document.body.appendChild(script);
    }).catch((e) => { scriptLoading = null; throw e; });
  }
  return scriptLoading;
}

/** Opens Razorpay's checkout; resolves with what it hands back, or null when it's closed without paying. */
function openCheckout(order: RazorpayOrder): Promise<{ paid: RazorpaySuccess | null; lastError?: string }> {
  return new Promise((resolve) => {
    let lastError: string | undefined;
    const rzp = new window.Razorpay!({
      key: order.key_id,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency,
      name: order.name,
      description: order.description,
      prefill: order.prefill,
      theme: { color: '#543f7d' },
      handler: (paid: RazorpaySuccess) => resolve({ paid }),
      modal: { ondismiss: () => resolve({ paid: null, lastError }), confirm_close: true },
    });
    // Razorpay keeps its window open after a failed try so the person can try another way
    rzp.on('payment.failed', (r) => { lastError = r.error?.description; });
    rzp.open();
  });
}

/** Start paying for Pro. Resolves when the checkout is closed. */
export async function startCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
  if (request.provider !== 'razorpay') {
    return { status: 'unavailable', message: "Card payments aren't available yet. Choose Razorpay." };
  }
  let order: RazorpayOrder;
  try {
    order = (await api.post('/api/v1/billing/checkout', { billing: request.billing, currency: request.currency })).data.data;
  } catch (e) {
    return { status: 'failed', message: parseApiError(e) };
  }
  try {
    await loadCheckoutScript();
  } catch {
    return { status: 'failed', message: "Couldn't load Razorpay. Check your connection (or an ad blocker) and try again." };
  }
  const { paid, lastError } = await openCheckout(order);
  if (!paid) {
    return lastError ? { status: 'failed', message: `The payment didn't go through: ${lastError}` } : { status: 'cancelled' };
  }
  try {
    const data = (await api.post('/api/v1/billing/verify', paid)).data.data as { payment: string; current: CurrentPlan };
    if (data.payment === 'paid' && data.current.plan === 'pro') return { status: 'paid', current: data.current };
    return { status: 'pending', message: "We got your payment. Pro turns on as soon as Razorpay confirms it (usually a few minutes)." };
  } catch (e: any) {
    // 502: Razorpay couldn't be asked just now; its webhook still turns Pro on
    if (e?.response?.status === 502) return { status: 'pending', message: parseApiError(e) };
    return { status: 'failed', message: `${parseApiError(e)}. If you were charged, write to support@shareeven.com.` };
  }
}

/** Pro as admins set it, for the website's pricing section (no sign-in needed). */
export async function loadPublicPlan(): Promise<ProPlan> {
  return (await api.get('/api/v1/billing/public-plan')).data.data as ProPlan;
}

export interface PlanInfo {
  pro: ProPlan;
  current: CurrentPlan;
}

/** Pro as admins set it (prices, features, providers) and the signed-in person's plan. */
export async function loadPlan(): Promise<PlanInfo> {
  try {
    const r = await api.get('/api/v1/billing/plan');
    return r.data.data as PlanInfo;
  } catch {
    return { pro: DEFAULT_PRO, current: { plan: 'free' } }; // offline: the built-in plan, and the server decides at checkout
  }
}

/** What admins edit: the plan, plus currencies that are switched off (the apps never get those). */
export interface AdminProPlan extends Omit<ProPlan, 'prices'> {
  prices: Record<string, Record<Billing, number> & { enabled: boolean }>;
}

/** Admin console → Pro & payments. */
export const adminBilling = {
  get: () => api.get('/api/v1/admin/billing').then((r) => r.data.data as AdminProPlan),
  save: (plan: AdminProPlan) => api.put('/api/v1/admin/billing', plan).then((r) => r.data.data as AdminProPlan),
};
