// src/components/organisms/PlanSettings.tsx
// Settings → ShareEven Pro: Free and Pro side by side, monthly or yearly, who takes the payment, and
// the button that starts it. Prices, features and providers are set by admins (Admin → Pro & payments);
// the payment itself goes through services/billing.service.ts (the only place a payment provider is wired in). Same page as the phone's.

import React, { useEffect, useState } from 'react';
import { Check, CreditCard, Lock, Sparkles, Zap } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../app/AuthProvider';
import { expenseService } from '../../services/expense.service';
import { loadPlan, startCheckout } from '../../services/billing.service';
import type { PlanInfo } from '../../services/billing.service';
import { DEFAULT_PRO, formatPrice, freeFeatures, perMonth, planCurrency, pricePer, providersFor, yearlySaving } from '../../utils/plans';
import type { Billing, Provider } from '../../utils/plans';

const card = 'bg-white border border-muted-200 rounded-[17px] shadow-[0_3px_14px_rgba(26,20,37,0.035)]';

const Feature: React.FC<{ text: string; strong?: boolean }> = ({ text, strong }) => (
  <li className="flex items-start gap-2.5">
    <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${strong ? 'text-primary-700' : 'text-muted-400'}`} strokeWidth={2.5} />
    <span className={`text-sm leading-snug ${strong ? 'text-muted-900' : 'text-muted-600'}`}>{text}</span>
  </li>
);

const PlanSettings: React.FC = () => {
  const { user } = useAuth();
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const pro = info?.pro || DEFAULT_PRO;
  const plan = info?.current;
  const currency = planCurrency(pro, user?.display_currency, typeof navigator !== 'undefined' ? navigator.language : '');
  const providers = providersFor(pro, currency);
  const [billing, setBilling] = useState<Billing>('yearly');
  const [provider, setProvider] = useState<Provider | null>(null);
  const [freeScans, setFreeScans] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadPlan().then(setInfo);
    expenseService.aiSettings().then((s) => setFreeScans(s.usage.monthly_limit)).catch(() => setFreeScans(null));
  }, []);

  const price = pro.prices[currency][billing];
  const saving = yearlySaving(pro, currency);
  const isPro = plan?.plan === 'pro';
  const chosen = providers.find((p) => p.id === provider) || providers[0];
  const canPay = pro.payments_enabled && !!chosen;

  const pay = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const result = await startCheckout({ billing, currency, provider: chosen.id });
      if (result.status === 'paid') {
        setInfo(await loadPlan());
        toast.success("You're on Pro. Thank you for supporting ShareEven.");
      } else if (result.status === 'unavailable') {
        toast.info(result.message);
      }
    } catch {
      toast.error("Couldn't start the payment. You have not been charged; try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-[18px]">
      <section className="flex items-center gap-4 p-[18px] sm:p-6 rounded-[17px] bg-primary-700 text-white">
        <span className="grid place-items-center w-11 h-11 flex-shrink-0 rounded-xl bg-white/15"><Sparkles className="w-[22px] h-[22px]" /></span>
        <div>
          <h2 className="font-display text-xl font-bold tracking-tight">ShareEven Pro</h2>
          <p className="mt-0.5 text-xs sm:text-sm text-white/85">More receipt scans, and you help keep ShareEven independent and ad-free.</p>
        </div>
      </section>
      {plan && (
        <p className="text-center text-xs text-muted-500">
          {isPro
            ? `You're on Pro${plan.until ? ` until ${new Date(plan.until).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.`
            : "You're on Free."}
        </p>
      )}

      <div role="tablist" aria-label="Billing period" className="flex p-1 rounded-[13px] bg-muted-100 border border-muted-200 max-w-sm mx-auto">
        {(['monthly', 'yearly'] as Billing[]).map((b) => (
          <button key={b} role="tab" aria-selected={billing === b} onClick={() => setBilling(b)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[10px] text-sm font-semibold transition-colors ${billing === b ? 'bg-white text-muted-900 shadow-sm' : 'text-muted-500 hover:text-muted-700'}`}>
            {b === 'monthly' ? 'Monthly' : 'Yearly'}
            {b === 'yearly' && saving > 0 && <span className="text-[10px] font-bold text-success-600 bg-[#eaf7ee] px-1.5 py-0.5 rounded-lg">Save {saving}%</span>}
          </button>
        ))}
      </div>

      <div className="grid gap-[18px] md:grid-cols-2">
        <section className={`${card} p-[18px] sm:p-6 border-2 !border-primary-500 md:order-2`} aria-label="Pro plan">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-bold text-muted-900">Pro</h3>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-[10px] bg-primary-100 text-primary-700"><Zap className="w-3 h-3" />Recommended</span>
          </div>
          <p className="mt-2 font-display text-[30px] font-bold tracking-tight text-muted-900 tabular-nums">
            {formatPrice(price, currency)} <span className="text-sm font-semibold tracking-normal text-muted-500">/ {pricePer(billing)}</span>
          </p>
          <p className="text-xs text-muted-500">
            {billing === 'yearly' ? `${formatPrice(perMonth(price), currency)} a month, paid once for the year` : 'Paid once for the month'}
          </p>
          <ul className="mt-4 space-y-2.5">{pro.features.map((f) => <Feature key={f} text={f} strong />)}</ul>
        </section>

        <section className={`${card} p-[18px] sm:p-6 md:order-1`} aria-label="Free plan">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-bold text-muted-900">Free</h3>
            {!isPro && <span className="text-[10px] font-bold px-2 py-1 rounded-[10px] bg-muted-100 text-muted-600">Your plan</span>}
          </div>
          <p className="mt-2 font-display text-[30px] font-bold tracking-tight text-muted-900 tabular-nums">{formatPrice(0, currency)}</p>
          <p className="text-xs text-muted-500">Always free</p>
          <ul className="mt-4 space-y-2.5">{freeFeatures(freeScans).map((f) => <Feature key={f} text={f} />)}</ul>
        </section>
      </div>

      {providers.length > 0 && <div>
        <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-500">Pay with</p>
        <div role="radiogroup" aria-label="Pay with" className={`${card} overflow-hidden`}>
          {providers.map((p) => {
            const on = p.id === chosen?.id;
            return (
              <button key={p.id} role="radio" aria-checked={on} onClick={() => setProvider(p.id)}
                className="w-full flex items-center gap-3 text-left px-4 sm:px-[18px] py-3.5 border-t border-muted-200 first:border-t-0 hover:bg-primary-50 transition-colors">
                <span className="grid place-items-center w-10 h-10 flex-shrink-0 rounded-[11px] bg-primary-50 text-primary-700"><CreditCard className="w-[18px] h-[18px]" /></span>
                <span className="flex-1 min-w-0 grid gap-[3px]">
                  <strong className="text-sm font-bold text-muted-900">{p.label}</strong>
                  <small className="text-xs text-muted-500">{p.methods}</small>
                </span>
                <span className={`grid place-items-center w-5 h-5 flex-shrink-0 rounded-full border-2 ${on ? 'border-primary-700' : 'border-muted-300'}`}>
                  {on && <span className="w-2.5 h-2.5 rounded-full bg-primary-700" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>}

      <div className="grid gap-3">
        <button onClick={pay} disabled={busy || !canPay}
          className="w-full sm:w-auto sm:justify-self-start sm:min-w-[260px] h-12 px-6 rounded-[13px] bg-primary-700 hover:bg-primary-800 text-white text-sm font-bold shadow-[0_6px_16px_rgba(84,63,125,0.25)] disabled:opacity-60 transition-colors">
          {busy ? 'Opening payment…' : !pro.payments_enabled ? 'Pro is coming soon' : !chosen ? `Can't pay in ${currency} yet`
            : `${isPro ? `Add a ${pricePer(billing)}` : 'Get Pro'} · ${formatPrice(price, currency)}`}
        </button>
        <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-muted-500 max-w-[65ch]">
          <Lock className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>
            Paid securely through {chosen?.id === 'razorpay' ? 'Razorpay' : 'our card payment provider'}: ShareEven never sees your card or bank details.
            Pro doesn't renew by itself; we'll remind you before it ends. Prices include taxes.
          </span>
        </p>
      </div>
    </div>
  );
};

export default PlanSettings;
