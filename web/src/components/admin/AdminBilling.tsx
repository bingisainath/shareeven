// src/components/admin/AdminBilling.tsx
// Admin console → Pro & payments: the prices, features, scans and payment providers that the Plan
// page shows on web and phone. Saved on the server (PUT /admin/billing), checked there, and logged.
// Prices are typed in normal amounts (999, 29.99) and stored in minor units (99900, 2999).

import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { CreditCard, Plus, Sparkles, Trash2 } from 'lucide-react';
import { adminBilling } from '../../services/billing.service';
import type { AdminProPlan } from '../../services/billing.service';
import { formatPrice, perMonth, CARD_PROVIDER_READY } from '../../utils/plans';
import { parseApiError } from '../../utils/apiError';

interface PriceRow { currency: string; monthly: string; yearly: string; enabled: boolean }
interface Form {
  payments_enabled: boolean;
  scans_per_month: string;
  prices: PriceRow[];
  features: string;
  razorpay: boolean;
  card: boolean;
  razorpay_currencies: string;
}

const major = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));
const minor = (text: string) => {
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
};

const toForm = (p: AdminProPlan): Form => ({
  payments_enabled: p.payments_enabled,
  scans_per_month: String(p.scans_per_month),
  prices: Object.entries(p.prices).map(([currency, v]) => ({ currency, monthly: major(v.monthly), yearly: major(v.yearly), enabled: v.enabled !== false })),
  features: p.features.join('\n'),
  razorpay: p.providers.razorpay,
  card: p.providers.card,
  razorpay_currencies: p.providers.razorpay_currencies.join(', '),
});

/** The form as a plan, or the first thing wrong with it (the server checks again). */
function toPlan(f: Form): AdminProPlan | string {
  const scans = Number(f.scans_per_month);
  if (!Number.isInteger(scans) || scans < 1) return 'Scans a month must be a whole number, at least 1';
  if (!f.prices.length) return 'Add at least one price';
  const prices: AdminProPlan['prices'] = {};
  for (const row of f.prices) {
    const code = row.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return `"${row.currency}" isn't a currency code (3 letters, e.g. INR)`;
    if (prices[code]) return `${code} is listed twice`;
    const monthly = minor(row.monthly);
    const yearly = minor(row.yearly);
    if (Number.isNaN(monthly) || Number.isNaN(yearly)) return `${code}: enter both prices, more than 0`;
    if (yearly > monthly * 12) return `${code}: a year costs more than twelve months`;
    prices[code] = { monthly, yearly, enabled: row.enabled };
  }
  if (!f.prices.some((r) => r.enabled)) return 'Turn on at least one currency';
  const features = f.features.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!features.length) return 'Add at least one feature';
  if (features.length > 8) return 'Up to 8 features';
  if (!f.razorpay && !f.card) return 'Turn on at least one payment provider';
  const razorpayCurrencies = f.razorpay_currencies.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  return {
    payments_enabled: f.payments_enabled,
    scans_per_month: scans,
    prices,
    features,
    providers: { razorpay: f.razorpay, card: f.card, razorpay_currencies: razorpayCurrencies },
  };
}

const input = 'h-9 px-2.5 rounded-lg border border-muted-300 bg-white text-sm outline-none focus:border-primary-500';
const label = 'text-xs font-semibold text-muted-700';

const Toggle: React.FC<{ on: boolean; onChange: (on: boolean) => void; label: string }> = ({ on, onChange, label: name }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={name} onClick={() => onChange(!on)}
    className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors ${on ? 'bg-primary-600' : 'bg-muted-300'}`}>
    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
  </button>
);

const AdminBilling: React.FC = () => {
  const [saved, setSaved] = useState<AdminProPlan | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminBilling.get().then((p) => { setSaved(p); setForm(toForm(p)); }).catch((e) => setError(parseApiError(e)));
  }, []);

  const plan = useMemo(() => (form ? toPlan(form) : null), [form]);
  const problem = typeof plan === 'string' ? plan : '';
  const dirty = !!form && !!saved && JSON.stringify(toForm(saved)) !== JSON.stringify(form);

  if (error) return <p role="alert" className="text-sm text-accent-700">{error}</p>;
  if (!form) return <p className="text-sm text-muted-500">Loading…</p>;

  const set = (changes: Partial<Form>) => setForm({ ...form, ...changes });
  const setRow = (i: number, changes: Partial<PriceRow>) => set({ prices: form.prices.map((r, j) => (j === i ? { ...r, ...changes } : r)) });

  const save = async () => {
    if (!plan || typeof plan === 'string') return;
    setBusy(true);
    try {
      const p = await adminBilling.save(plan);
      setSaved(p);
      setForm(toForm(p));
      toast.success('Pro plan saved. People see it the next time they open the Plan page.');
    } catch (e) {
      toast.error(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="card p-4 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <span className="grid place-items-center w-10 h-10 flex-shrink-0 rounded-[11px] bg-primary-50 text-primary-700"><Sparkles className="w-5 h-5" /></span>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-muted-900">ShareEven Pro</h2>
            <p className="text-sm text-muted-500">What the Plan page shows on web and phone (Settings → ShareEven Pro). Changes apply the next time someone opens it.</p>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-xl bg-muted-50 border border-muted-200">
          <div className="flex-1">
            <p className="text-sm font-semibold text-muted-900">Take payments</p>
            <p className="text-xs text-muted-500">
              {form.payments_enabled
                ? 'On: the Get Pro button starts a payment (once a provider is connected).'
                : 'Off: people see the plans, and the button says Pro is coming soon.'}
            </p>
          </div>
          <Toggle on={form.payments_enabled} onChange={(on) => set({ payments_enabled: on })} label="Take payments" />
        </div>

        <label className="flex flex-wrap items-center gap-3">
          <span className={label}>Receipt scans a month on Pro</span>
          <input value={form.scans_per_month} inputMode="numeric" onChange={(e) => set({ scans_per_month: e.target.value })}
            className={`${input} w-24 text-right tabular-nums`} />
        </label>
      </section>

      <section className="card p-4 sm:p-6 space-y-3">
        <div>
          <h3 className="text-base font-semibold text-muted-900">Prices</h3>
          <p className="text-sm text-muted-500">Including taxes. People pay in their display currency when it's on here; otherwise INR in India, and EUR, then USD, elsewhere. A switched-off currency keeps its prices but isn't offered.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[580px]">
            <thead>
              <tr className="text-left text-xs text-muted-500">
                <th className="py-2 pr-3 font-semibold">On</th>
                <th className="py-2 pr-3 font-semibold">Currency</th>
                <th className="py-2 pr-3 font-semibold">A month</th>
                <th className="py-2 pr-3 font-semibold">A year</th>
                <th className="py-2 pr-3 font-semibold">Year saves</th>
                <th className="py-2 w-10"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {form.prices.map((row, i) => {
                const m = minor(row.monthly);
                const y = minor(row.yearly);
                const code = row.currency.trim().toUpperCase();
                const saving = m > 0 && y > 0 ? Math.round((1 - y / (m * 12)) * 100) : null;
                return (
                  <tr key={i} className={`border-t border-muted-100 ${row.enabled ? '' : 'opacity-50'}`}>
                    <td className="py-2 pr-3">
                      <Toggle on={row.enabled} onChange={(on) => setRow(i, { enabled: on })} label={`Offer ${code || 'this currency'}`} />
                    </td>
                    <td className="py-2 pr-3">
                      <input value={row.currency} maxLength={3} onChange={(e) => setRow(i, { currency: e.target.value.toUpperCase() })}
                        aria-label="Currency code" className={`${input} w-20 uppercase font-mono`} />
                    </td>
                    <td className="py-2 pr-3">
                      <input value={row.monthly} inputMode="decimal" onChange={(e) => setRow(i, { monthly: e.target.value })}
                        aria-label={`${code} a month`} className={`${input} w-28 text-right tabular-nums`} />
                    </td>
                    <td className="py-2 pr-3">
                      <input value={row.yearly} inputMode="decimal" onChange={(e) => setRow(i, { yearly: e.target.value })}
                        aria-label={`${code} a year`} className={`${input} w-28 text-right tabular-nums`} />
                    </td>
                    <td className="py-2 pr-3 text-xs tabular-nums">
                      {saving === null ? '–' : saving < 0
                        ? <span className="text-accent-700">Dearer than monthly</span>
                        : <span className="text-muted-600">{saving}% · {/^[A-Z]{3}$/.test(code) ? formatPrice(perMonth(y), code) : ''}/mo</span>}
                    </td>
                    <td className="py-2">
                      <button type="button" onClick={() => set({ prices: form.prices.filter((_, j) => j !== i) })} aria-label={`Remove ${code || 'this price'}`}
                        className="grid place-items-center w-8 h-8 rounded-lg text-muted-400 hover:text-accent-700 hover:bg-accent-50">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={() => set({ prices: [...form.prices, { currency: '', monthly: '', yearly: '', enabled: true }] })}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:underline">
          <Plus className="w-4 h-4" /> Add a currency
        </button>
      </section>

      <section className="card p-4 sm:p-6 space-y-3">
        <div>
          <h3 className="text-base font-semibold text-muted-900">What Pro gives</h3>
          <p className="text-sm text-muted-500">One per line, up to 8. <code className="px-1 rounded bg-muted-100 text-xs">{'{scans}'}</code> becomes the number of scans above.</p>
        </div>
        <textarea value={form.features} onChange={(e) => set({ features: e.target.value })} rows={5} aria-label="Pro features"
          className="w-full px-3 py-2 rounded-lg border border-muted-300 text-sm outline-none focus:border-primary-500" />
      </section>

      <section className="card p-4 sm:p-6 space-y-3">
        <div>
          <h3 className="text-base font-semibold text-muted-900">Payment providers</h3>
          <p className="text-sm text-muted-500">Which ways to pay the Plan page offers.</p>
        </div>
        <div className="divide-y divide-muted-100">
          <div className="flex flex-wrap items-center gap-3 py-3">
            <CreditCard className="w-5 h-5 text-primary-700" />
            <div className="flex-1 min-w-[12rem]">
              <p className="text-sm font-semibold text-muted-900">Razorpay</p>
              <p className="text-xs text-muted-500">UPI, cards, net banking and wallets</p>
            </div>
            <label className="flex items-center gap-2">
              <span className={label}>Currencies</span>
              <input value={form.razorpay_currencies} onChange={(e) => set({ razorpay_currencies: e.target.value.toUpperCase() })}
                disabled={!form.razorpay} placeholder="INR" className={`${input} w-32 font-mono disabled:opacity-50`} />
            </label>
            <Toggle on={form.razorpay} onChange={(on) => set({ razorpay: on })} label="Razorpay" />
          </div>
          <div className="flex flex-wrap items-center gap-3 py-3">
            <CreditCard className="w-5 h-5 text-primary-700" />
            <div className="flex-1 min-w-[12rem]">
              <p className="text-sm font-semibold text-muted-900">Credit or debit card</p>
              <p className="text-xs text-muted-500">{CARD_PROVIDER_READY ? 'Every currency above' : "Not built yet: people aren't offered it even when it's on. Currencies Razorpay doesn't take can't be paid."}</p>
            </div>
            <Toggle on={form.card} onChange={(on) => set({ card: on })} label="Credit or debit card" />
          </div>
        </div>
      </section>

      <div className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 bg-muted-50/95 backdrop-blur flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy || !dirty || !!problem}
          className="h-10 px-5 rounded-lg bg-primary-700 hover:bg-primary-800 text-white text-sm font-bold disabled:opacity-50">
          {busy ? 'Saving…' : 'Save Pro plan'}
        </button>
        {dirty && (
          <button type="button" onClick={() => saved && setForm(toForm(saved))} className="h-10 px-3 text-sm font-semibold text-muted-600 hover:text-muted-900">
            Discard changes
          </button>
        )}
        {problem && dirty && <p role="alert" className="text-sm text-accent-700">{problem}</p>}
        {!dirty && <p className="text-xs text-muted-500">All changes saved</p>}
      </div>
    </div>
  );
};

export default AdminBilling;
