// src/components/expenses/ExpenseSettingsSections.tsx
// Settings page: store discounts; chat expense settings; and (admin console) which
// AI model reads receipts and the monthly scan limit. ShareEven picks the model, not each person.

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { expenseService } from '../../services/expense.service';
import type { AdminAI, AIModelOption, SplitRules, StoreDiscount } from '../../services/expense.service';
import { parseApiError } from '../../utils/apiError';
import { firstName, PersonToggle, Switch, useChatMoney } from './shared';
import { RECEIPT_CATEGORIES, categoryLabel } from '../../utils/receiptCategories';

const emptyRule = { store_name: '', percent: '10', excluded_categories: [] as string[], stacks_with_reduced: false, active: true };

export const StoreDiscountSettings: React.FC = () => {
  const [rules, setRules] = useState<StoreDiscount[]>([]);
  const [draft, setDraft] = useState<(typeof emptyRule & { id?: number; excluded: string }) | null>(null);

  const load = useCallback(() => {
    expenseService.storeDiscounts().then(setRules).catch((e) => toast.error(parseApiError(e)));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!draft) return;
    try {
      await expenseService.saveStoreDiscount({
        store_name: draft.store_name,
        percent: draft.percent,
        excluded_categories: draft.excluded.split(',').map((s) => s.trim()).filter(Boolean),
        stacks_with_reduced: draft.stacks_with_reduced,
        active: draft.active,
      }, draft.id);
      setDraft(null);
      load();
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };

  return (
    <div className="card p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-muted-900">Store discounts</h2>
          <p className="text-sm text-muted-500">
            E.g. a staff or member discount at one shop. When it isn’t printed on a receipt we add it switched off, so you can turn it on.
          </p>
        </div>
        {!draft && (
          <button type="button" onClick={() => setDraft({ ...emptyRule, excluded: '' })} className="flex-shrink-0 px-3 py-1.5 text-sm rounded-lg bg-primary-50 text-primary-700">Add</button>
        )}
      </div>

      {rules.map((r) => (
        <div key={r.id} className="flex items-center gap-3 py-2 border-b border-muted-100">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-muted-900">{r.store_name} · {r.percent}%</p>
            <p className="text-xs text-muted-500">
              {r.stacks_with_reduced ? 'Also on reduced items' : 'Not on reduced items'}
              {r.excluded_categories.length > 0 && ` · not on ${r.excluded_categories.join(', ')}`}
            </p>
          </div>
          <Switch
            checked={r.active}
            label={`${r.store_name} discount active`}
            onChange={(active) => expenseService.saveStoreDiscount({ ...r, active }, r.id).then(load).catch((e) => toast.error(parseApiError(e)))}
          />
          <button type="button" onClick={() => setDraft({ ...r, excluded: r.excluded_categories.join(', ') })} className="text-sm text-primary-700">Edit</button>
          <button type="button" onClick={() => expenseService.deleteStoreDiscount(r.id).then(load).catch((e) => toast.error(parseApiError(e)))} className="text-sm text-accent-600">Delete</button>
        </div>
      ))}

      {draft && (
        <div className="p-3 rounded-xl border border-muted-200 space-y-2">
          <div className="flex gap-2">
            <input value={draft.store_name} onChange={(e) => setDraft({ ...draft, store_name: e.target.value })} placeholder="Store, e.g. Tesco" aria-label="Store" className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-muted-300" />
            <input value={draft.percent} inputMode="decimal" onChange={(e) => setDraft({ ...draft, percent: e.target.value })} aria-label="Percent" className="w-20 px-3 py-2 rounded-lg border border-muted-300 text-right" />
            <span className="self-center">%</span>
          </div>
          <input value={draft.excluded} onChange={(e) => setDraft({ ...draft, excluded: e.target.value })} placeholder="Not on (categories, comma separated), e.g. alcohol" className="w-full px-3 py-2 rounded-lg border border-muted-300 text-sm" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.stacks_with_reduced} onChange={(e) => setDraft({ ...draft, stacks_with_reduced: e.target.checked })} />
            Also applies to reduced / already-discounted items
          </label>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setDraft(null)} className="px-3 py-1.5 text-sm text-muted-600">Cancel</button>
            <button type="button" onClick={save} className="px-3 py-1.5 text-sm rounded-lg bg-primary-600 text-white">Save</button>
          </div>
        </div>
      )}
    </div>
  );
};

export const AdminAISettings: React.FC = () => {
  const [data, setData] = useState<AdminAI | null>(null);
  const [limit, setLimit] = useState('');
  const [newModel, setNewModel] = useState<{ provider: 'anthropic' | 'openai'; model_id: string; label: string } | null>(null);

  useEffect(() => {
    expenseService.admin().then((d) => { setData(d); setLimit(String(d.receipt_scans_per_month)); }).catch(() => undefined);
  }, []);

  if (!data) return null;

  const saveModel = async (m: AIModelOption, patch: Partial<AIModelOption>) => {
    try {
      const next = { ...m, ...patch };
      setData(await expenseService.adminSaveModel({
        provider: next.provider, model_id: next.model_id, label: next.label, description: next.description,
        enabled: next.enabled ?? true, is_default: next.is_default, sort_order: next.sort_order ?? 0,
      }, m.id));
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };

  return (
    <div className="card p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-muted-900">Receipt AI</h2>
        <p className="text-sm text-muted-500">
          The default model reads every receipt, on the app’s key. People can’t pick a model or add their own keys.
        </p>
        <p className="text-sm text-muted-500">
          Server keys: Claude {data.app_keys.anthropic ? 'set' : 'not set'} · OpenAI {data.app_keys.openai ? 'set' : 'not set'}.
          Keys are set in the server’s environment, never here.
        </p>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setData(await expenseService.adminScanLimit(Number(limit)));
            toast.success('Limit saved');
          } catch (error) {
            toast.error(parseApiError(error));
          }
        }}
      >
        <label className="text-sm text-muted-700">Free scans per person per month</label>
        <input value={limit} inputMode="numeric" onChange={(e) => setLimit(e.target.value)} className="w-20 px-2 py-1.5 rounded-lg border border-muted-300 text-right" />
        <button type="submit" className="px-3 py-1.5 text-sm rounded-lg bg-primary-600 text-white">Save</button>
      </form>

      <div className="space-y-2">
        {data.models.map((m) => (
          <div key={m.id} className="flex items-center gap-3 py-1.5">
            <Switch checked={!!m.enabled} label={`${m.label} enabled`} onChange={(enabled) => saveModel(m, { enabled, is_default: enabled && m.is_default })} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{m.label}</p>
              <p className="text-xs text-muted-500 font-mono">{m.provider} · {m.model_id}</p>
            </div>
            {m.is_default ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-primary-100 text-primary-700">Default</span>
            ) : m.enabled && (
              <button type="button" onClick={() => saveModel(m, { is_default: true })} className="text-xs text-primary-700 hover:underline">Make default</button>
            )}
          </div>
        ))}
      </div>

      {newModel ? (
        <div className="flex flex-wrap gap-2">
          <select value={newModel.provider} onChange={(e) => setNewModel({ ...newModel, provider: e.target.value as 'anthropic' | 'openai' })} className="px-2 py-1.5 rounded-lg border border-muted-300 text-sm">
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
          </select>
          <input value={newModel.model_id} onChange={(e) => setNewModel({ ...newModel, model_id: e.target.value })} placeholder="model id" className="flex-1 min-w-[8rem] px-2 py-1.5 rounded-lg border border-muted-300 text-sm font-mono" />
          <input value={newModel.label} onChange={(e) => setNewModel({ ...newModel, label: e.target.value })} placeholder="Label people see" className="flex-1 min-w-[8rem] px-2 py-1.5 rounded-lg border border-muted-300 text-sm" />
          <button
            type="button"
            onClick={async () => {
              try {
                setData(await expenseService.adminSaveModel({ ...newModel, description: '', enabled: true, is_default: false, sort_order: data.models.length + 1 }));
                setNewModel(null);
              } catch (error) {
                toast.error(parseApiError(error));
              }
            }}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary-600 text-white"
          >
            Add
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setNewModel({ provider: 'anthropic', model_id: '', label: '' })} className="text-sm text-primary-700 hover:underline">+ Add a model</button>
      )}
    </div>
  );
};

/** Expense settings for one chat (inside the chat info panel). */
export const ChatExpenseSettings: React.FC<{ conversationId: string; onOpenExpenses: () => void }> = ({ conversationId, onOpenExpenses }) => {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof expenseService.settings>> | null>(null);
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    expenseService.settings(conversationId).then(setSettings).catch(() => undefined);
    expenseService.currencies().then(setCurrencies).catch(() => undefined);
  }, [conversationId]);

  if (!settings) return null;
  const update = async (patch: Parameters<typeof expenseService.updateSettings>[1]) => {
    try {
      setSettings(await expenseService.updateSettings(conversationId, patch));
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };
  const disabled = !settings.can_edit;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-700">Expenses</h3>
        <button type="button" onClick={onOpenExpenses} className="text-sm text-primary-700 hover:underline">Balances & expenses</button>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Default currency</span>
        <select value={settings.default_currency} disabled={disabled} onChange={(e) => update({ default_currency: e.target.value })} className="px-2 py-1 rounded-lg border border-muted-300 bg-white disabled:opacity-60">
          {(currencies.length ? currencies : [{ code: settings.default_currency, name: '' }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
      </label>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>Simplify debts <span className="block text-xs text-muted-500">Fewest payments to settle up</span></span>
        <Switch checked={settings.simplify_debts} disabled={disabled} label="Simplify debts" onChange={(simplify_debts) => update({ simplify_debts })} />
      </div>
      {disabled && <p className="text-xs text-muted-500">Only group admins can change these.</p>}
      <SplitRulesSettings conversationId={conversationId} />
    </div>
  );
};

/** A chat's split rules: items of a category go to the same people whenever a receipt is scanned. */
const SplitRulesSettings: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const [rules, setRules] = useState<SplitRules | null>(null);
  const [editing, setEditing] = useState<{ category: string; user_ids: string[]; isNew: boolean } | null>(null);
  const { members } = useChatMoney(conversationId);

  useEffect(() => {
    expenseService.splitRules(conversationId).then(setRules).catch(() => undefined);
  }, [conversationId]);

  if (!rules) return null;
  const nameOf = (id: string) => firstName(members.find((m) => m.id === id)) || 'Someone';
  const who = (ids: string[]) => (ids.length ? ids.map(nameOf).join(', ') : 'Everyone, equally');
  const save = async (next: { category: string; user_ids: string[] }[]) => {
    try {
      setRules(await expenseService.updateSplitRules(conversationId, next));
      setEditing(null);
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };
  const current = rules.rules.map((r) => ({ category: r.category, user_ids: r.user_ids }));
  const unused = RECEIPT_CATEGORIES.filter((c) => !rules.rules.some((r) => r.category === c.key));

  return (
    <div className="pt-3 border-t border-muted-100 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-muted-700">Split rules</h4>
        <p className="text-xs text-muted-500">When a receipt is scanned, items in these categories go to the same people. You can still change any item.</p>
      </div>
      {rules.rules.length > 0 && (
        <ul className="rounded-xl border border-muted-200 divide-y divide-muted-100">
          {rules.rules.map((r) => (
            <li key={r.category} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex-1 min-w-0">
                <span className="block font-medium text-muted-900">{r.label}</span>
                <span className="block text-xs text-muted-500 truncate">{who(r.user_ids)}</span>
              </span>
              {rules.can_edit && (
                <>
                  <button type="button" onClick={() => setEditing({ category: r.category, user_ids: r.user_ids, isNew: false })} className="text-xs font-semibold text-primary-700 hover:underline">Edit</button>
                  <button type="button" onClick={() => save(current.filter((x) => x.category !== r.category))} className="text-xs font-semibold text-accent-600 hover:underline">Remove</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="rounded-xl border border-primary-200 bg-primary-50/50 p-3 space-y-2.5 text-sm">
          {editing.isNew ? (
            <label className="flex items-center gap-2">Category
              <select value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} className="flex-1 px-2 py-1.5 rounded-lg border border-muted-300 bg-white">
                {unused.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
          ) : <p className="font-medium text-muted-900">{categoryLabel(editing.category)}</p>}
          <p className="text-xs text-muted-600">Who are these items for? Pick nobody for everyone, split equally.</p>
          <div className="flex flex-wrap gap-2.5">
            {members.map((m) => (
              <PersonToggle key={m.id} member={m} size="xs" label={firstName(m)} selected={editing.user_ids.includes(m.id)}
                onToggle={() => setEditing({ ...editing, user_ids: editing.user_ids.includes(m.id) ? editing.user_ids.filter((u) => u !== m.id) : [...editing.user_ids, m.id] })} />
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => save([...current.filter((x) => x.category !== editing.category), { category: editing.category, user_ids: editing.user_ids }])}
              className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs font-semibold">Save rule</button>
            <button type="button" onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-lg bg-muted-100 text-xs font-semibold">Cancel</button>
          </div>
        </div>
      ) : rules.can_edit && unused.length > 0 && (
        <button type="button" onClick={() => setEditing({ category: unused[0].key, user_ids: [], isNew: true })}
          className="w-full h-9 rounded-lg border border-dashed border-primary-300 text-xs font-semibold text-primary-700 hover:bg-primary-50">
          + Add a rule
        </button>
      )}
      {!rules.can_edit && rules.rules.length === 0 && <p className="text-xs text-muted-500">No rules yet. Group admins can add them.</p>}
    </div>
  );
};
