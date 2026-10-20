// src/screens/settings/PlanScreen.tsx
// Settings → ShareEven Pro: Free and Pro side by side, monthly or yearly, who takes the payment, and
// the button that starts it. Prices, features and providers are set by admins (GET /billing/plan);
// the payment itself goes through api/billing.ts (the only place a payment provider is wired in). Same page as the web app's.
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Check, CreditCard, Lock, Sparkles, Zap } from 'lucide-react-native';
import { SettingsLabel, SettingsPage } from '../../components/settings/SettingsUI';
import { Button } from '../../components/common/ui';
import { showAlert } from '../../components/common/Dialog';
import { expenseService } from '../../api/expenses';
import { loadPlan, startCheckout } from '../../api/billing';
import type { PlanInfo } from '../../api/billing';
import { useAuth } from '../../store/auth';
import { colors } from '../../theme';
import { DEFAULT_PRO, formatPrice, freeFeatures, perMonth, planCurrency, pricePer, providersFor, yearlySaving } from '../../utils/plans';
import type { Billing, Provider } from '../../utils/plans';

const locale = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return '';
  }
};

const PlanScreen: React.FC = () => {
  const user = useAuth((s) => s.user);
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const pro = info?.pro || DEFAULT_PRO;
  const plan = info?.current;
  const currency = planCurrency(pro, user?.display_currency, locale());
  const providers = providersFor(pro, currency);
  const [billing, setBilling] = useState<Billing>('yearly');
  const [provider, setProvider] = useState<Provider | null>(null);
  const [freeScans, setFreeScans] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(useCallback(() => {
    loadPlan().then(setInfo);
    expenseService.aiSettings().then((s) => setFreeScans(s.usage.monthly_limit)).catch(() => setFreeScans(null));
  }, []));

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
        showAlert("You're on Pro", 'Thank you for supporting ShareEven.', undefined, { tone: 'success' });
      } else if (result.status === 'unavailable') {
        showAlert('Not available yet', result.message);
      }
    } catch {
      showAlert("Couldn't start the payment", 'Check your connection and try again. You have not been charged.');
    } finally {
      setBusy(false);
    }
  };

  // Never show the built-in prices while the real ones load
  if (!info) {
    return <SettingsPage><ActivityIndicator color={colors.primary700} style={styles.loading} accessibilityLabel="Loading plans" /></SettingsPage>;
  }

  return (
    <SettingsPage>
      <View style={styles.hero}>
        <View style={styles.heroIcon}><Sparkles size={22} color={colors.white} /></View>
        <View style={styles.flex}>
          <Text style={styles.heroTitle}>ShareEven Pro</Text>
          <Text style={styles.heroSub}>More receipt scans, and you help keep ShareEven independent and ad-free.</Text>
        </View>
      </View>
      {plan && (
        <Text style={styles.current}>
          {isPro
            ? `You're on Pro${plan.until ? ` until ${new Date(plan.until).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.`
            : "You're on Free."}
        </Text>
      )}

      <View style={styles.toggle} accessibilityRole="tablist">
        {(['monthly', 'yearly'] as Billing[]).map((b) => (
          <Pressable key={b} onPress={() => setBilling(b)} accessibilityRole="tab" accessibilityState={{ selected: billing === b }}
            style={[styles.toggleItem, billing === b && styles.toggleOn]}>
            <Text style={[styles.toggleText, billing === b && styles.toggleTextOn]}>{b === 'monthly' ? 'Monthly' : 'Yearly'}</Text>
            {b === 'yearly' && saving > 0 && <Text style={styles.save}>Save {saving}%</Text>}
          </Pressable>
        ))}
      </View>

      <View style={[styles.plan, styles.planPro]}>
        <View style={styles.planHead}>
          <Text style={styles.planName}>Pro</Text>
          <View style={styles.tag}><Zap size={11} color={colors.primary700} /><Text style={styles.tagText}>Recommended</Text></View>
        </View>
        <Text style={styles.price}>{formatPrice(price, currency)} <Text style={styles.per}>/ {pricePer(billing)}</Text></Text>
        <Text style={styles.priceNote}>
          {billing === 'yearly'
            ? `${formatPrice(perMonth(price), currency)} a month, paid once for the year`
            : 'Paid once for the month'}
        </Text>
        <View style={styles.features}>
          {pro.features.map((f) => <Feature key={f} text={f} strong />)}
        </View>
      </View>

      <View style={styles.plan}>
        <View style={styles.planHead}>
          <Text style={styles.planName}>Free</Text>
          {!isPro && <View style={[styles.tag, styles.tagMuted]}><Text style={[styles.tagText, { color: colors.muted600 }]}>Your plan</Text></View>}
        </View>
        <Text style={styles.price}>{formatPrice(0, currency)}</Text>
        <View style={styles.features}>
          {freeFeatures(freeScans).map((f) => <Feature key={f} text={f} />)}
        </View>
      </View>

      {providers.length > 0 && <View style={styles.section}><SettingsLabel text="Pay with" /></View>}
      {providers.length > 0 && <View style={styles.providers} accessibilityRole="radiogroup">
        {providers.map((p, i) => {
          const on = p.id === chosen?.id;
          return (
            <Pressable key={p.id} onPress={() => setProvider(p.id)} accessibilityRole="radio" accessibilityState={{ checked: on }}
              accessibilityLabel={`${p.label}: ${p.methods}`}
              style={({ pressed }) => [styles.provider, i > 0 && styles.providerBorder, pressed && { backgroundColor: colors.primary50 }]}>
              <View style={styles.providerIcon}><CreditCard size={18} color={colors.primary700} /></View>
              <View style={styles.flex}>
                <Text style={styles.providerName}>{p.label}</Text>
                <Text style={styles.providerMethods}>{p.methods}</Text>
              </View>
              <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
            </Pressable>
          );
        })}
      </View>}

      <Button
        title={!pro.payments_enabled ? 'Pro is coming soon' : !chosen ? `Can't pay in ${currency} yet`
          : `${isPro ? `Add a ${pricePer(billing)}` : 'Get Pro'} · ${formatPrice(price, currency)}`}
        onPress={pay} loading={busy} disabled={!canPay} style={styles.cta} />
      <View style={styles.fine}>
        <Lock size={12} color={colors.muted500} />
        <Text style={styles.fineText}>
          Paid securely through {chosen?.id === 'razorpay' ? 'Razorpay' : 'our card payment provider'}: ShareEven never sees your card or bank details.
          Pro doesn't renew by itself; we'll remind you before it ends. Prices include taxes.
        </Text>
      </View>
    </SettingsPage>
  );
};

const Feature: React.FC<{ text: string; strong?: boolean }> = ({ text, strong }) => (
  <View style={styles.feature}>
    <Check size={15} color={strong ? colors.primary700 : colors.muted400} strokeWidth={2.5} />
    <Text style={[styles.featureText, strong && { color: colors.muted900 }]}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 48 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 17, backgroundColor: colors.primary700 },
  heroIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, color: colors.white },
  heroSub: { marginTop: 3, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.85)' },
  current: { marginTop: 12, fontSize: 12, color: colors.muted500, textAlign: 'center' },
  toggle: { marginTop: 16, flexDirection: 'row', padding: 4, borderRadius: 13, backgroundColor: colors.muted100, borderWidth: 1, borderColor: colors.muted200 },
  toggleItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 10 },
  toggleOn: { backgroundColor: colors.white, shadowColor: '#1a1425', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  toggleText: { fontSize: 13, fontWeight: '600', color: colors.muted500 },
  toggleTextOn: { color: colors.muted900 },
  save: { fontSize: 10, fontWeight: '700', color: colors.success700, backgroundColor: colors.success50, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
  plan: { marginTop: 14, padding: 18, borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200 },
  planPro: { borderWidth: 2, borderColor: colors.primary500 },
  planHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planName: { fontSize: 15, fontWeight: '700', color: colors.muted900 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: colors.primary100 },
  tagMuted: { backgroundColor: colors.muted100 },
  tagText: { fontSize: 10, fontWeight: '700', color: colors.primary700 },
  price: { marginTop: 8, fontSize: 30, fontWeight: '700', letterSpacing: -0.8, color: colors.muted900 },
  per: { fontSize: 14, fontWeight: '600', letterSpacing: 0, color: colors.muted500 },
  priceNote: { marginTop: 2, fontSize: 12, color: colors.muted500 },
  features: { marginTop: 14, gap: 9 },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  featureText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.muted600 },
  section: { marginTop: 22 },
  providers: { borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200, overflow: 'hidden' },
  provider: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  providerBorder: { borderTopWidth: 1, borderTopColor: colors.muted200 },
  providerIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.primary50, alignItems: 'center', justifyContent: 'center' },
  providerName: { fontSize: 14, fontWeight: '700', color: colors.muted900 },
  providerMethods: { marginTop: 2, fontSize: 12, color: colors.muted500 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.muted300, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.primary700 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary700 },
  cta: { marginTop: 20 },
  fine: { marginTop: 12, flexDirection: 'row', gap: 7, paddingHorizontal: 4 },
  fineText: { flex: 1, fontSize: 11, lineHeight: 16, color: colors.muted500 },
});

export default PlanScreen;
