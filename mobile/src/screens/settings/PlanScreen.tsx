// src/screens/settings/PlanScreen.tsx
// Settings → ShareEven Pro on the phone: what Pro and Free give, and whether this person has Pro (and
// until when). Nothing is sold here, and nothing points to where Pro can be bought (store rules: see
// api/billing.ts). Features come from the plan admins set (GET /billing/plan).
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Check, Sparkles } from 'lucide-react-native';
import { SettingsPage } from '../../components/settings/SettingsUI';
import { expenseService } from '../../api/expenses';
import { loadPlan } from '../../api/billing';
import type { PlanInfo } from '../../api/billing';
import { colors } from '../../theme';
import { freeFeatures } from '../../utils/plans';

const PlanScreen: React.FC = () => {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const [freeScans, setFreeScans] = useState<number | null>(null);

  useFocusEffect(useCallback(() => {
    loadPlan().then(setInfo);
    expenseService.aiSettings().then((s) => setFreeScans(s.usage.monthly_limit)).catch(() => setFreeScans(null));
  }, []));

  if (!info) {
    return <SettingsPage><ActivityIndicator color={colors.primary700} style={styles.loading} accessibilityLabel="Loading plans" /></SettingsPage>;
  }
  const plan = info.current;
  const isPro = plan.plan === 'pro';
  const until = plan.until ? new Date(plan.until).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  return (
    <SettingsPage>
      <View style={styles.hero}>
        <View style={styles.heroIcon}><Sparkles size={22} color={colors.white} /></View>
        <View style={styles.flex}>
          <Text style={styles.heroTitle}>ShareEven Pro</Text>
          <Text style={styles.heroSub}>More receipt scans, and you help keep ShareEven independent and ad-free.</Text>
        </View>
      </View>
      <Text style={styles.current}>
        {isPro ? `You're on Pro${until ? ` until ${until}` : ''}. It doesn't renew by itself; we'll remind you before it ends.` : "You're on Free."}
      </Text>

      <View style={[styles.plan, isPro && styles.planPro]}>
        <View style={styles.planHead}>
          <Text style={styles.planName}>Pro</Text>
          {isPro && <View style={styles.tag}><Text style={styles.tagText}>Your plan</Text></View>}
        </View>
        <View style={styles.features}>
          {info.pro.features.map((f) => <Feature key={f} text={f} strong />)}
        </View>
      </View>

      <View style={[styles.plan, !isPro && styles.planPro]}>
        <View style={styles.planHead}>
          <Text style={styles.planName}>Free</Text>
          {!isPro && <View style={styles.tag}><Text style={styles.tagText}>Your plan</Text></View>}
        </View>
        <View style={styles.features}>
          {freeFeatures(freeScans).map((f) => <Feature key={f} text={f} />)}
        </View>
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
  plan: { marginTop: 14, padding: 18, borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200 },
  planPro: { borderWidth: 2, borderColor: colors.primary500 },
  planHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planName: { fontSize: 15, fontWeight: '700', color: colors.muted900 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: colors.primary100 },
  tagText: { fontSize: 10, fontWeight: '700', color: colors.primary700 },
  features: { marginTop: 14, gap: 9 },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  featureText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.muted600 },
});

export default PlanScreen;
