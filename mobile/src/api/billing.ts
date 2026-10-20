// src/api/billing.ts
// ShareEven Pro on the phone: what it gives and whether this person has it. The phone doesn't sell
// Pro. Google Play (and the App Store) require their own billing for digital features bought in an
// app, and forbid pointing people to pay elsewhere. So there is no buy button, price or link to the
// website here. People who buy on the web (web/src/services/billing.service.ts, Razorpay) get Pro
// here too: the server decides it, and GET /billing/plan reports it.
//
// Selling in the app later means Play Billing, or Razorpay under Google's India alternative
// billing. Decide that first: both change store compliance and fees.
import { api } from './client';
import { DEFAULT_PRO } from '../utils/plans';
import type { ProPlan } from '../utils/plans';

export interface CurrentPlan {
  plan: 'free' | 'pro';
  /** Pro: when it ends (ISO date and time). */
  until?: string;
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
    return { pro: DEFAULT_PRO, current: { plan: 'free' } }; // offline: the built-in plan
  }
}
