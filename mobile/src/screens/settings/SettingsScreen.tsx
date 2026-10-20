// src/screens/settings/SettingsScreen.tsx
// Settings home (Figma design): the profile card (opens Account) and one list. Notifications and
// currency are set right here; the other rows open their own pages.
import React, { useCallback, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ban, Bell, ChevronRight, Coins, HelpCircle, Inbox, KeyRound, LogOut, MonitorSmartphone, ReceiptText, ShieldCheck, Sparkles, Store } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Avatar from '../../components/common/Avatar';
import { SettingsCard, SettingsRow } from '../../components/settings/SettingsUI';
import { expenseService } from '../../api/expenses';
import { enablePush, pushStatus } from '../../notifications/push';
import CurrencyPicker from '../../components/expenses/CurrencyPicker';
import { authApi } from '../../api/auth';
import { loadPlan } from '../../api/billing';
import { errorMessage } from '../../api/client';
import { logoutRisk } from '../../crypto/backupRuntime';
import { useAuth } from '../../store/auth';
import { useChat } from '../../store/chat';
import { useNotices } from '../../store/notices';
import { colors, space } from '../../theme';
import type { AppStackParams } from '../../navigation/types';
import { showAlert } from '../../components/common/Dialog';

type PushState = Awaited<ReturnType<typeof pushStatus>>;

const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParams>>();
  const { user, logout, setUser } = useAuth();
  const unreadNotices = useNotices((st) => st.unread);
  const [push, setPush] = useState<PushState | null>(null);
  const [pickingCurrency, setPickingCurrency] = useState(false);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [pro, setPro] = useState(false);

  // Re-check when the screen is shown and when coming back from the phone's settings
  useFocusEffect(useCallback(() => {
    const check = () => pushStatus().then(setPush);
    check();
    loadPlan().then((p) => setPro(p.current.plan === 'pro')).catch(() => undefined);
    expenseService.aiSettings()
      .then(({ usage }) => setScansLeft(Math.max(0, usage.monthly_limit - usage.scans_this_month)))
      .catch(() => setScansLeft(null));
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(); });
    return () => sub.remove();
  }, []));

  if (!user) return null;

  // Android lets an app ask for notifications but not take the permission back: turning on asks (or
  // opens the phone's settings if it was refused for good); turning off opens the phone's settings.
  const setNotifications = async (on: boolean) => {
    if (on) {
      await enablePush();
      const now = await pushStatus();
      setPush(now);
      if (now === 'on') return;
    }
    Linking.openSettings();
  };

  // "Show totals in": expense amounts in other currencies also show converted (≈)
  const setDisplayCurrency = async (code: string) => {
    try {
      setUser(await authApi.updateMe({ display_currency: code }));
    } catch (e) {
      showAlert("Couldn't save that", errorMessage(e));
    }
  };

  const confirmLogout = async () => {
    // Logging out of the last signed-in device makes encrypted chats unreadable: warn first
    const risk = await logoutRisk().catch(() => ({ lastDevice: true, hasBackup: false }));
    const doLogout = async () => { useChat.getState().reset(); await logout(); };
    if (!risk.lastDevice) {
      showAlert('Log out?', 'You can sign back in any time.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log out', style: 'destructive', onPress: doLogout },
      ]);
    } else if (risk.hasBackup) {
      showAlert('Log out of your only device?', "No other phone or browser is signed in. To read your encrypted chats again after logging out, you'll need your 64-digit backup recovery key. Make sure you have it.", [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log out anyway', style: 'destructive', onPress: doLogout },
      ]);
    } else {
      showAlert('Log out of your only device?', "No other phone or browser is signed in, and you have no backup. If you log out, your end-to-end encrypted chats can't be read again, on any device.", [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn on backup', onPress: () => navigation.navigate('Backup') },
        { text: 'Log out anyway', style: 'destructive', onPress: doLogout },
      ]);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>PERSONALISE SHAREEVEN</Text>
          <Text style={styles.title} accessibilityRole="header">Settings</Text>
          <Text style={styles.subtitle}>Privacy, account and app preferences.</Text>
        </View>

        <Pressable onPress={() => navigation.navigate('Account')} accessibilityRole="button" accessibilityHint="Opens your account"
          style={({ pressed }) => [styles.profile, pressed && { backgroundColor: colors.primary50 }]}>
          <Avatar uri={user.avatar} name={user.name || user.username} size={72} />
          <View style={styles.profileText}>
            <Text style={styles.name} numberOfLines={1}>{user.name || user.username}</Text>
            <Text style={styles.meta} numberOfLines={2}>@{user.username} · {user.email}</Text>
            {!!user.bio && <Text style={styles.meta} numberOfLines={2}>{user.bio}</Text>}
          </View>
          <ChevronRight size={16} color={colors.muted400} />
        </Pressable>

        <SettingsCard>
          <SettingsRow first icon={Sparkles} label="ShareEven Pro" hint="More receipt scans; plans and payment"
            badge={pro ? { text: 'Pro', tone: 'good' } : { text: 'Free', tone: 'off' }} onPress={() => navigation.navigate('Plan')} />
          <SettingsRow icon={KeyRound} label="Encryption & backup" hint="Recovery key and secure backups" onPress={() => navigation.navigate('Backup')} />
          <SettingsRow icon={MonitorSmartphone} label="Linked devices" hint="Link a phone or browser, see where you're signed in" onPress={() => navigation.navigate('Encryption')} />
          <SettingsRow icon={Bell} label="Notifications"
            hint={push === 'unavailable' ? "Not set up in this build of the app" : 'Messages, expense reminders and new device requests'}
            badge={push === 'unavailable' ? { text: 'Not set up', tone: 'off' } : undefined}
            right={push === 'on' || push === 'off' ? (
              <Switch value={push === 'on'} onValueChange={setNotifications} accessibilityLabel="Notifications"
                trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white} />
            ) : undefined} />
          <SettingsRow icon={ReceiptText} label="Receipt scanning" hint="Your monthly scans"
            badge={scansLeft === null ? undefined : { text: `${scansLeft} scans left`, tone: scansLeft > 0 ? 'good' : 'warn' }}
            onPress={() => navigation.navigate('ReceiptScanning')} />
          <SettingsRow icon={Store} label="Store discounts" hint="Your personal store offers" onPress={() => navigation.navigate('StoreDiscounts')} />
          <SettingsRow icon={Coins} label="Currency" hint="Also show amounts converted at today's rate"
            badge={{ text: user.display_currency || 'Off', tone: user.display_currency ? 'tint' : 'off' }} onPress={() => setPickingCurrency(true)} />
          <SettingsRow icon={Ban} label="Blocked people" hint="People who can't message you" onPress={() => navigation.navigate('BlockedPeople')} />
          <SettingsRow icon={Inbox} label="Notices" hint="Messages from the ShareEven team"
            badge={unreadNotices ? { text: `${unreadNotices} new`, tone: 'warn' } : undefined} onPress={() => navigation.navigate('Notices')} />
          <SettingsRow icon={HelpCircle} label="Help & about" hint="FAQ, contact us, terms and privacy" onPress={() => navigation.navigate('Help')} />
        </SettingsCard>
        <CurrencyPicker visible={pickingCurrency} value={user.display_currency || ''} offLabel="Off (original currencies only)"
          onClose={() => setPickingCurrency(false)} onPick={(code) => { setPickingCurrency(false); setDisplayCurrency(code); }} />

        <Pressable onPress={() => navigation.navigate('Backup')} accessibilityRole="button"
          style={({ pressed }) => [styles.banner, pressed && { opacity: 0.85 }]}>
          <ShieldCheck size={20} color={colors.primary700} />
          <View style={styles.bannerText}>
            <Text style={styles.bannerTitle}>Your privacy is protected</Text>
            <Text style={styles.bannerSub}>Messages and expense details are end-to-end encrypted.</Text>
          </View>
        </Pressable>

        <SettingsCard style={styles.logout}>
          <SettingsRow first icon={LogOut} label="Log out" danger onPress={confirmLogout} />
        </SettingsCard>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  page: { paddingHorizontal: space(4), paddingTop: 22, paddingBottom: space(8) },
  header: { marginBottom: 20 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.3, color: colors.primary500 },
  title: { marginTop: 3, fontSize: 28, fontWeight: '700', letterSpacing: -1, color: colors.muted900 },
  subtitle: { marginTop: 5, fontSize: 12, color: colors.muted500 },
  profile: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 18, padding: 18, marginBottom: 18,
    backgroundColor: colors.white, borderRadius: 17, borderWidth: 1, borderColor: colors.muted200,
    shadowColor: '#1a1425', shadowOpacity: 0.035, shadowRadius: 14, shadowOffset: { width: 0, height: 3 }, elevation: 1,
  },
  profileText: { flex: 1, minWidth: 0 },
  name: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, color: colors.muted900 },
  meta: { marginTop: 5, fontSize: 12, lineHeight: 17, color: colors.muted500 },
  banner: { marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 16, paddingHorizontal: 20, borderRadius: 15, backgroundColor: colors.primary100 },
  bannerText: { flex: 1, gap: 3 },
  bannerTitle: { fontSize: 14, fontWeight: '700', color: colors.primary700 },
  bannerSub: { fontSize: 11, lineHeight: 15, color: colors.primary700 },
  logout: { marginTop: 18 },
});

export default SettingsScreen;
