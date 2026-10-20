// src/screens/settings/ReceiptScanningScreen.tsx
// Settings → Receipt scanning: scans used this month out of the monthly allowance. ShareEven picks
// the AI model; there's nothing to configure.
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AppStackParams } from '../../navigation/types';
import { ReceiptText, Sparkles } from 'lucide-react-native';
import { SettingsCard, SettingsNote, SettingsPage } from '../../components/settings/SettingsUI';
import { expenseService } from '../../api/expenses';
import type { AISettings } from '../../api/expenses';
import { errorMessage } from '../../api/client';
import { Banner, Button } from '../../components/common/ui';
import { colors } from '../../theme';

const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString([], { day: 'numeric', month: 'long' });
};

const ReceiptScanningScreen: React.FC = () => {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const [usage, setUsage] = useState<AISettings['usage'] | null>(null);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    expenseService.aiSettings().then((s) => { setUsage(s.usage); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, []));

  const limit = usage?.monthly_limit ?? 0;
  const used = usage?.scans_this_month ?? 0;
  const left = Math.max(0, limit - used);
  const share = limit > 0 ? Math.min(1, used / limit) : 1;

  return (
    <SettingsPage>
      {!!error && <Banner text={error} />}
      <SettingsCard style={styles.card}>
        {!usage ? <ActivityIndicator color={colors.primary700} /> : (
          <>
            <View style={styles.top}>
              <View style={styles.icon}><ReceiptText size={20} color={colors.primary700} /></View>
              <View style={styles.flex}>
                <Text style={styles.big}>{left} <Text style={styles.of}>of {limit} scans left</Text></Text>
                <Text style={styles.sub}>{limit === 0 ? 'Receipt scanning is paused for your account.' : `This month. Resets on ${nextMonth()}.`}</Text>
              </View>
            </View>
            <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: limit, now: used }}>
              <View style={[styles.fill, { width: `${share * 100}%` }, left === 0 && { backgroundColor: colors.warning700 }]} />
            </View>
            <Text style={styles.used}>{used} used</Text>
          </>
        )}
      </SettingsCard>
      {!!usage && left <= 3 && (
        <Button title="Get more scans with Pro" variant="secondary" icon={Sparkles} style={styles.note}
          onPress={() => navigation.navigate('Plan')} />
      )}
      <SettingsNote icon={Sparkles} style={styles.note} title="How it works"
        text="In a chat, tap Add expense and scan a receipt. ShareEven reads the items and prices so you can split them; you check everything before saving. Each receipt counts as one scan; scans that fail don't count." />
    </SettingsPage>
  );
};

const styles = StyleSheet.create({
  card: { padding: 18 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 11, backgroundColor: colors.primary50, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  big: { fontSize: 26, fontWeight: '700', letterSpacing: -0.5, color: colors.muted900 },
  of: { fontSize: 14, fontWeight: '600', color: colors.muted500, letterSpacing: 0 },
  sub: { marginTop: 2, fontSize: 12, color: colors.muted500 },
  track: { marginTop: 16, height: 8, borderRadius: 4, backgroundColor: colors.primary100, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.primary700 },
  used: { marginTop: 6, fontSize: 11, color: colors.muted500, textAlign: 'right' },
  note: { marginTop: 18 },
});

export default ReceiptScanningScreen;
