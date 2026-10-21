// src/screens/settings/SessionsScreen.tsx
// Settings → Sessions: the phones and browsers signed in to this account right now, with when each
// signed in and was last active, and whether it's linked for end-to-end encryption. Devices unused for 30+
// days (a reset phone, a browser whose data was cleared) are offered for removal: they can't approve anything.
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Globe, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react-native';
import { api, errorMessage } from '../../api/client';
import { Banner } from '../../components/common/ui';
import { v2Runtime } from '../../crypto/v2-platform/runtime';
import { logOutDevice } from '../../crypto/v2-platform/link';
import { useAuth } from '../../store/auth';
import { showAlert } from '../../components/common/Dialog';
import { colors, radius, space } from '../../theme';
import { unusedDevices } from '../../utils/devices';

export interface Session {
  device_id: number;
  name: string;
  created_at: string | null;
  last_seen_at: string | null;
  linked: boolean;
  active_now?: boolean;
  unused?: boolean;
}

const BROWSERS = /^(Chrome|Firefox|Safari|Edge|Browser)\b/;

/** "Active now", "5 min ago", "Yesterday, 14:05", "3 Oct 2026" */
export function activeLabel(iso: string | null): string {
  if (!iso) return 'Unknown';
  const t = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 2) return 'Active now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown');

const SessionsScreen: React.FC = () => {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [mine, setMine] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const userId = useAuth((s) => s.user?.id);

  const logOut = (s: Session) => showAlert(`Log out ${s.name}?`, "It's signed out right away, its encrypted chats are wiped from it, and it would need linking again to use them.", [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Log out', style: 'destructive', onPress: async () => {
        setBusy(s.device_id);
        try {
          await logOutDevice(userId!, s.device_id);
          await load();
        } catch (e) {
          showAlert("Couldn't log it out", errorMessage(e));
        } finally {
          setBusy(null);
        }
      },
    },
  ]);

  const unused = sessions ? unusedDevices(sessions, mine) : [];
  const removeUnused = () => showAlert(
    `Remove ${unused.length} unused device${unused.length === 1 ? '' : 's'}?`,
    `${unused.map((s) => s.name).join(', ')}. None has been used for 30 days or more. Each is signed out and its encrypted chats are wiped from it; you can sign in there again any time.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          setBusy(-1);
          const failed: string[] = [];
          for (const s of unused) {
            try {
              await logOutDevice(userId!, s.device_id);
            } catch {
              failed.push(s.name);
            }
          }
          setBusy(null);
          await load();
          if (failed.length) showAlert("Couldn't remove some devices", failed.join(', '));
        },
      },
    ],
  );

  const load = useCallback(async () => {
    try {
      const [data, me] = await Promise.all([
        api.get('/e2e/v2/devices/me').then((r) => r.data.data.devices as Session[]),
        v2Runtime()?.then((r) => r.state.deviceId).catch(() => null) ?? Promise.resolve(null),
      ]);
      // This device first, then the most recently active
      setSessions([...data].sort((a, b) => Number(b.device_id === me) - Number(a.device_id === me)
        || new Date(b.last_seen_at || 0).getTime() - new Date(a.last_seen_at || 0).getTime()));
      setMine(me);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!sessions && !error) return <View style={styles.center}><ActivityIndicator color={colors.primary700} /></View>;

  return (
    <ScrollView contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <Text style={styles.lead}>Phones and browsers signed in to your account. Don't recognise one? Log it out.</Text>
      {!!error && <Banner text={error} />}
      {unused.length > 0 && (
        <View style={styles.unused}>
          <Text style={styles.unusedText}>
            {unused.length === 1 ? `${unused[0].name} hasn't` : `${unused.length} devices haven't`} been used for 30 days or more. Removing unused devices means a new device asks only the ones you really use.
          </Text>
          <Pressable onPress={removeUnused} disabled={busy !== null} style={[styles.unusedButton, busy !== null && { opacity: 0.5 }]} accessibilityRole="button">
            {busy === -1 ? <ActivityIndicator size="small" color={colors.warning700} /> : <Text style={styles.unusedButtonText}>Remove {unused.length === 1 ? 'it' : 'them'}</Text>}
          </Pressable>
        </View>
      )}
      {sessions?.map((s) => {
        const Icon = BROWSERS.test(s.name) ? Globe : Smartphone;
        const current = s.device_id === mine;
        return (
          <View key={s.device_id} style={[styles.card, current && styles.cardCurrent]}>
            <View style={[styles.icon, current && { backgroundColor: colors.primary700 }]}>
              <Icon size={20} color={current ? colors.white : colors.primary700} />
            </View>
            <View style={styles.flex}>
              <View style={styles.titleRow}>
                <Text style={styles.name} numberOfLines={1}>{s.name}</Text>
                {current && <Text style={styles.badge}>This device</Text>}
              </View>
              <Text style={styles.active}>{current || s.active_now ? 'Active now' : activeLabel(s.last_seen_at)}{s.unused && !current ? '  ·  Unused for 30+ days' : ''}</Text>
              <Text style={styles.detail}>Signed in {dateTime(s.created_at)}</Text>
              <View style={styles.encRow}>
                {s.linked ? <ShieldCheck size={13} color={colors.success700} /> : <ShieldOff size={13} color={colors.warning700} />}
                <Text style={[styles.detail, { color: s.linked ? colors.success700 : colors.warning700 }]}>
                  {s.linked ? 'Linked: can read your encrypted chats' : 'Not linked yet: waiting to be approved'}
                </Text>
              </View>
              {!current && (
                <Pressable onPress={() => logOut(s)} disabled={busy !== null} style={[styles.logout, busy !== null && { opacity: 0.5 }]} accessibilityLabel={`Log out ${s.name}`}>
                  {busy === s.device_id ? <ActivityIndicator size="small" color={colors.danger600} /> : <Text style={styles.logoutText}>Log out</Text>}
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { padding: space(4), paddingBottom: space(10), gap: space(3), backgroundColor: colors.background, flexGrow: 1 },
  lead: { fontSize: 13, color: colors.muted500 },
  flex: { flex: 1 },
  card: { flexDirection: 'row', gap: space(3), padding: space(4), borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200 },
  cardCurrent: { borderColor: colors.primary300 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary50 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  name: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.muted900 },
  badge: { fontSize: 11, fontWeight: '700', color: colors.primary800, backgroundColor: colors.primary50, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full, overflow: 'hidden' },
  active: { marginTop: 2, fontSize: 13, color: colors.muted700 },
  detail: { fontSize: 12, color: colors.muted500, marginTop: 2 },
  logout: { alignSelf: 'flex-start', marginTop: space(2.5), paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.md, borderWidth: 1, borderColor: colors.muted200 },
  logoutText: { fontSize: 13, fontWeight: '600', color: colors.danger600 },
  encRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space(1) },
  unused: { padding: space(3), borderRadius: radius.lg, backgroundColor: colors.warning50, gap: space(2) },
  unusedText: { fontSize: 13, lineHeight: 18, color: colors.warning700 },
  unusedButton: { alignSelf: 'flex-start', paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.md, borderWidth: 1, borderColor: colors.warning700, backgroundColor: colors.white },
  unusedButtonText: { fontSize: 13, fontWeight: '600', color: colors.warning700 },
});

export default SessionsScreen;
