// src/api/billing.ts (same flow as web/src/services/billing.service.ts)
// Paying for ShareEven Pro. The Plan page only calls the two functions below, so wiring a real
// payment provider in means filling them in; nothing on the page changes.
//
// To wire up (planned):
//   1. POST /billing/checkout { billing, currency, provider } -> the server creates the order with
//      Razorpay (or the card provider) for the price admins set (GET /billing/plan) and returns what the
//      provider's checkout needs ({ provider, order_id, key_id, ... } or a hosted checkout URL).
//   2. Open that checkout (Razorpay's SDK, or the hosted page in the browser).
//   3. The server learns of the payment from the provider's webhook (checked with its signature)
//      and turns Pro on; GET /billing/plan then reports it. The app never decides that itself.
import { api } from './client';
import { DEFAULT_PRO } from '../utils/plans';
import type { Billing, ProPlan, Provider } from '../utils/plans';

export interface CheckoutRequest {
  billing: Billing;
  currency: string;
  provider: Provider;
}

export type CheckoutResult =
  | { status: 'paid' }
  | { status: 'cancelled' }
  | { status: 'unavailable'; message: string };

export interface CurrentPlan {
  plan: 'free' | 'pro';
  /** Pro: the day it ends (ISO date). */
  until?: string;
}

/** Start paying for Pro. Resolves when the checkout is closed. */
export async function startCheckout(_request: CheckoutRequest): Promise<CheckoutResult> {
  // Not wired to a payment provider yet (whether or not admins have turned payments on)
  return { status: 'unavailable', message: "Payments aren't open yet. Pro will be available soon." };
}

export interface PlanInfo {
  pro: ProPlan;
  current: CurrentPlan;
}

/** Pro as admins set it (prices, features, providers) and the signed-in person's plan. */
export async function loadPlan(): Promise<PlanInfo> {
  try {
    const r = await api.get('/billing/plan');
    return r.data.data as PlanInfo;
  } catch {
    return { pro: DEFAULT_PRO, current: { plan: 'free' } }; // offline: the built-in plan, and the server decides at checkout
  }
}
