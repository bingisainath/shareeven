// src/screens/auth/E2EGate.tsx
// After sign-in, before the chats: make sure this phone has the account's encryption keys
// (same flow as web/src/app/E2EGate.tsx).
// - First device on the account: keys are created here silently, nothing to do.
// - Another device already has them: show a QR code (and a code to type); that device adds this
//   phone to the account and sends the keys and message history over (encrypted for this phone
//   alone) from Settings → End-to-end encryption → Link a device.
// - No other device available: start fresh with new keys; older encrypted messages can't be read.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import AuthLayout from './AuthLayout';
import { Banner, Button, TextField } from '../../components/common/ui';
import { publicKeysOf } from '../../crypto/e2e';
import { e2eSession } from '../../crypto/session';
import { linkHere, listStatus, startFreshV2 } from '../../crypto/v2-platform/link';
import type { LinkHere } from '../../crypto/v2-platform/link';
import { e2eService } from '../../services/e2e.service';
import type { MyKeys } from '../../services/e2e.service';
import { errorMessage, reportLoggedOutElsewhere } from '../../api/client';
import { startV2 } from '../../crypto/v2-platform/runtime';
import { backupIfDue, restoreFromBackup } from '../../crypto/backupRuntime';
import { forgetRecoveryKey, hasSavedRecoveryKey, readSavedRecoveryKey, saveErrorMessage, saveRecoveryKey } from '../../crypto/savedRecoveryKey';
import { syncV2 } from '../../store/chat';
import { isRecoveryKey } from '../../crypto/backup';
import { api } from '../../api/client';
import { useAuth } from '../../store/auth';
import { phoneName } from '../../utils/device';
import { colors, radius, space } from '../../theme';
import { showAlert } from '../../components/common/Dialog';
import { DeviceRemovedError } from '../../crypto/v2/device';
import { approvers, lastActive } from '../../utils/devices';
import type { LinkedDevice } from '../../utils/devices';

/**
 * Which of the account's linked devices can approve this phone, and whether any is open right now. A closed
 * browser still counts as linked but can't answer until it's opened again.
 */
const WhoCanApprove: React.FC = () => {
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/e2e/v2/devices/me')
      .then((r) => { if (alive) setDevices(approvers(r.data.data.devices as LinkedDevice[])); })
      .catch(() => undefined);
    load();
    const timer = setInterval(load, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!devices) return null;
  if (!devices.length) {
    return (
      <View style={styles.approvers}>
        <Text style={styles.noneOpen} accessibilityRole="alert">
          All the devices that were linked to your account have logged out, so none can approve this phone. Choose “Don't have your other device?” below to restore from your backup or start fresh.
        </Text>
      </View>
    );
  }
  const anyOpen = devices.some((d) => d.active_now);
  return (
    <View style={styles.approvers}>
      {!anyOpen && (
        <Text style={styles.noneOpen} accessibilityRole="alert">
          None of your linked devices is open right now. Open ShareEven on one of them to approve this phone, or choose “Don't have your other device?” below.
        </Text>
      )}
      <Text style={styles.approversTitle}>YOUR LINKED DEVICES</Text>
      <View style={styles.approverList}>
        {devices.map((d, i) => (
          <View key={d.device_id} style={[styles.approver, i > 0 && styles.approverBorder]}>
            <Text style={styles.approverName} numberOfLines={1}>{d.name}</Text>
            <Text style={[styles.approverSeen, d.active_now && styles.approverOpen]}>{d.active_now ? '● ' : ''}{lastActive(d)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
};

type Stage = { name: 'checking' } | { name: 'ready' } | { name: 'link'; mine: MyKeys } | { name: 'error'; message: string };


const E2EGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout } = useAuth();
  const [stage, setStage] = useState<Stage>({ name: 'checking' });
  const userId = user?.id;

  const check = useCallback(async () => {
    if (!userId) return;
    setStage({ name: 'checking' });
    try {
      const mine = await e2eService.mine();
      // Version 1 keys from earlier on this phone: only for reading older messages, so optional.
      // Dropped if they were replaced or retired on another device since.
      if (mine.has_keys && (await e2eSession.restore(userId))) {
        if (publicKeysOf(e2eSession.keys()!).enc !== mine.enc_public) await e2eSession.clear();
      } else {
        await e2eSession.clear();
      }
      const hasV1 = !!e2eSession.keys();
      // Registers this phone; the account's first device creates the signed device list (and the account key)
      const status = await listStatus(userId);
      if (status === 'orphaned' && hasV1) {
        // Every device that held the account key has logged out, but this phone has the keys:
        // it becomes the account's first device (contacts see a new security code; nothing is lost)
        await startFreshV2(userId);
      }
      if (status === 'listed' || (status === 'orphaned' && hasV1)) {
        setStage({ name: 'ready' });
        return;
      }
      setStage({ name: 'link', mine });
    } catch (e) {
      // Logged out from another device while this phone stayed signed in: sign out, like any remote logout
      if (e instanceof DeviceRemovedError) {
        reportLoggedOutElsewhere();
        return;
      }
      setStage({ name: 'error', message: errorMessage(e) });
    }
  }, [userId]);

  useEffect(() => { check(); }, [check]);

  // Encryption v2 starts in the background once this phone is ready (registers, uploads prekeys)
  useEffect(() => {
    if (stage.name === 'ready' && userId) {
      startV2(userId)
        .then(() => syncV2()) // v2 packets that arrived while signed out
        .then(() => backupIfDue(userId))
        .catch((e) => console.warn('Encryption v2 setup or backup failed (will retry next start):', e?.message || e));
    }
  }, [stage.name, userId]);

  // Our keys were replaced on another device: link again
  useEffect(() => e2eSession.onStale(() => { e2eSession.clear().then(check); }), [check]);

  if (stage.name === 'ready') return <>{children}</>;

  if (stage.name === 'checking') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary700} />
      </View>
    );
  }

  const footer = (
    <Text style={styles.footer}>
      Signed in as <Text style={styles.bold}>{user?.username}</Text> ·{' '}
      <Text style={styles.link} onPress={() => logout()}>Log out</Text>
    </Text>
  );

  if (stage.name === 'error') {
    return (
      <AuthLayout onBack={() => logout()} title="Couldn't check your encryption" subtitle={stage.message}>
        <Button title="Try again" onPress={check} />
        {footer}
      </AuthLayout>
    );
  }

  return <LinkThisPhone mine={stage.mine} userId={userId!} footer={footer} onDone={() => setStage({ name: 'ready' })} />;
};

const LinkThisPhone: React.FC<{ mine: MyKeys; userId: string; footer: React.ReactNode; onDone: () => void }> = ({ mine, userId, footer, onDone }) => {
  const { logout } = useAuth();
  const [link, setLink] = useState<LinkHere | null>(null);
  const [expired, setExpired] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showCode, setShowCode] = useState(false); // the QR / 16-character code instead of one-tap approval
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noDevice, setNoDevice] = useState(false);
  const [hasBackup, setHasBackup] = useState<boolean | null>(null); // null: still checking
  const [recoveryKey, setRecoveryKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [savedKey, setSavedKey] = useState(false);
  const attempt = useRef(0);
  const offered = useRef(false);

  useEffect(() => {
    api.get('/e2e/backup').then((r) => setHasBackup(!!r.data.data.exists)).catch(() => setHasBackup(false));
    hasSavedRecoveryKey(userId).then(setSavedKey);
  }, [userId]);

  /** Restore with a typed key, or (key = null) the one saved on this phone. */
  const restore = async (key: string | null = recoveryKey) => {
    setBusy(true);
    attempt.current += 1; // stop waiting for another device
    try {
      const fromPhone = key === null;
      const theKey = fromPhone ? await readSavedRecoveryKey(userId) : key;
      if (!theKey) {
        begin(); // cancelled the fingerprint / PIN: carry on as before
        return;
      }
      try {
        await restoreFromBackup(userId, theKey, mine.enc_public!);
      } catch (e) {
        if (fromPhone) {
          // The backup was made with a different key since: the saved one is useless now
          await forgetRecoveryKey(userId);
          setSavedKey(false);
        }
        throw e;
      }
      if (!fromPhone && remember) {
        await saveRecoveryKey(userId, theKey).catch((e) => showAlert('Restored, but the key wasn\'t saved', saveErrorMessage(e)));
      }
      onDone();
    } catch (e: any) {
      begin(); // keep waiting for another device too (this clears the error, so set it after)
      setError(e?.message || errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const begin = useCallback(async () => {
    const mineAttempt = ++attempt.current;
    setExpired(false);
    setDenied(false);
    setError('');
    setLink(null);
    try {
      const pending = await linkHere(userId, mine.enc_public!, phoneName());
      if (mineAttempt !== attempt.current) return;
      setLink(pending);
      const result = await pending.wait(() => mineAttempt !== attempt.current);
      if (mineAttempt !== attempt.current) return;
      if (result === 'denied') {
        setDenied(true);
        return;
      }
      if (result === 'expired') {
        setExpired(true);
        return;
      }
      onDone();
    } catch (e) {
      if (mineAttempt === attempt.current) setError(errorMessage(e));
    }
  }, [mine.enc_public, userId, onDone]);

  useEffect(() => {
    begin();
    return () => { attempt.current += 1; }; // stop waiting when leaving
  }, [begin]);

  useEffect(() => {
    if (!hasBackup || !savedKey || offered.current) return;
    offered.current = true;
    showAlert('Restore your chats?', 'Your recovery key is saved on this phone. Unlock it with your fingerprint or screen PIN to restore your encrypted chats.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Restore', onPress: () => { restore(null); } },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBackup, savedKey]);

  // Back (arrow or Android's back button): close the "no other device" panel, else offer to sign out
  const goBack = useCallback(() => {
    if (noDevice) {
      setNoDevice(false);
      return;
    }
    showAlert('Go back to sign in?', 'You can sign in again any time and link this phone then.', [
      { text: 'Stay here', style: 'cancel' },
      { text: 'Sign out', onPress: () => { attempt.current += 1; logout(); } },
    ]);
  }, [noDevice, logout]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { goBack(); return true; });
    return () => sub.remove();
  }, [goBack]);

  const startFresh = () => showAlert(
    'Start fresh with new keys?',
    "Your encrypted messages from before can't be read again, on any device, and the people you chat with will see that your keys changed.",
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start fresh', style: 'destructive', onPress: async () => {
          setBusy(true);
          attempt.current += 1;
          try {
            // New keys are version 2 only; the old version 1 keys are retired (nobody encrypts to them any more)
            if (mine.has_keys) await e2eService.retireKeys();
            await e2eSession.clear();
            await startFreshV2(userId);
            onDone();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ],
  );

  return (
    <AuthLayout
      onBack={goBack}
      title="Link this phone"
      subtitle={link?.number && !showCode
        ? 'Your chats are end-to-end encrypted. Your laptop or other signed-in device is asking "Is this you?". Tap this number there:'
        : "Your chats are end-to-end encrypted. On a device that's already signed in, open Settings → Linked devices → Link a device, then type the 16-character code below or scan the QR."}
    >
      {!!error && <Banner text={error} />}
      <View style={styles.qrBox}>
        {link && !expired && !denied ? (
          <>
            {link.number && !showCode ? (
              <>
                <View style={styles.numberBox} accessibilityLabel={`Number to pick on your other device: ${link.number}`}>
                  <Text style={styles.number}>{link.number}</Text>
                </View>
                <Text style={styles.small}>Don't see it? Open ShareEven on your other device.</Text>
              </>
            ) : (
              <>
                <View style={styles.qr}><QRCode value={link.qrText} size={200} /></View>
                <Text style={styles.small}>Type this code on the other device</Text>
                <Text style={styles.code} selectable>{link.code}</Text>
              </>
            )}
            <View style={styles.waiting}>
              <ActivityIndicator size="small" color={colors.primary700} />
              <Text style={styles.small}>Waiting for your other device…</Text>
            </View>
            {!!link.number && (
              <Pressable onPress={() => setShowCode((v) => !v)} hitSlop={8} style={{ marginTop: space(3) }}>
                <Text style={styles.link}>{showCode ? 'Approve with one tap instead' : 'Use a code instead'}</Text>
              </Pressable>
            )}
            <WhoCanApprove />
          </>
        ) : denied ? (
          <>
            <Text style={styles.small}>This was turned down on your other device.</Text>
            <Button title="Try again" onPress={begin} compact style={{ marginTop: space(3) }} />
          </>
        ) : expired ? (
          <>
            <Text style={styles.small}>The code expired.</Text>
            <Button title="Show a new code" onPress={begin} compact style={{ marginTop: space(3) }} />
          </>
        ) : error ? (
          <Button title="Try again" onPress={begin} compact />
        ) : (
          <ActivityIndicator color={colors.primary700} />
        )}
      </View>
      {hasBackup && (
        <View style={styles.noDevice}>
          <Text style={styles.noDeviceTitle}>Or restore from your backup</Text>
          {savedKey && (
            <Button title="Use the key saved on this phone" variant="secondary" onPress={() => restore(null)} disabled={busy}
              style={{ marginBottom: space(3) }} />
          )}
          <TextField label="64-digit recovery key" value={recoveryKey} onChangeText={setRecoveryKey} keyboardType="number-pad" autoCorrect={false} />
          <Pressable style={styles.remember} onPress={() => setRemember((r) => !r)}>
            <Switch value={remember} onValueChange={setRemember} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white} />
            <Text style={styles.rememberText}>Remember it on this phone, unlocked with your fingerprint or screen PIN</Text>
          </Pressable>
          <Button title={busy ? 'Restoring…' : 'Restore'} onPress={() => restore()} loading={busy} disabled={!isRecoveryKey(recoveryKey)} />
        </View>
      )}
      {hasBackup === false && (
        <Text style={styles.small}>
          This account has no backup yet, so there's no recovery key to enter. To make one: on a signed-in device,
          Settings → Linked devices → Encrypted backup.
        </Text>
      )}
      {noDevice ? (
        <Pressable onPress={startFresh} disabled={busy} style={styles.fresh}>
          <Text style={[styles.link, { color: colors.danger600 }]}>Start fresh with new keys</Text>
        </Pressable>
      ) : (
        <Pressable onPress={() => setNoDevice(true)} disabled={busy} style={styles.fresh}>
          <Text style={styles.link}>Don't have your other device?</Text>
        </Pressable>
      )}
      {footer}
    </AuthLayout>
  );
};

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  footer: { marginTop: space(5), textAlign: 'center', fontSize: 13, color: colors.muted500 },
  bold: { fontWeight: '600', color: colors.muted700 },
  link: { color: colors.primary700, fontWeight: '600' },
  qrBox: { alignItems: 'center', paddingVertical: space(2) },
  numberBox: { width: 120, height: 120, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary50, borderWidth: 1, borderColor: colors.primary100 },
  number: { fontSize: 60, fontWeight: '800', color: colors.primary700, fontVariant: ['tabular-nums'] },
  qr: { padding: space(3), backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.muted200 },
  small: { marginTop: space(3), fontSize: 12, color: colors.muted500, textAlign: 'center' },
  code: { marginTop: space(1), fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 18, letterSpacing: 1.5, color: colors.muted900 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  fresh: { alignItems: 'center', marginTop: space(5) },
  noDevice: { marginTop: space(5), padding: space(4), borderRadius: radius.lg, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  noDeviceTitle: { fontSize: 15, fontWeight: '600', color: colors.muted900, marginBottom: space(2) },
  remember: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginBottom: space(3) },
  rememberText: { flex: 1, fontSize: 13, color: colors.muted700 },
  approvers: { alignSelf: 'stretch', marginTop: space(5) },
  noneOpen: { marginBottom: space(2), padding: space(3), borderRadius: radius.md, backgroundColor: colors.warning50, color: colors.warning700, fontSize: 12, lineHeight: 17 },
  approversTitle: { marginBottom: space(1.5), fontSize: 11, fontWeight: '700', letterSpacing: 0.6, color: colors.muted500 },
  approverList: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
  approver: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(3), paddingHorizontal: space(3), paddingVertical: space(2.5) },
  approverBorder: { borderTopWidth: 1, borderTopColor: colors.muted200 },
  approverName: { flex: 1, fontSize: 13, color: colors.muted700 },
  approverSeen: { fontSize: 12, color: colors.muted500 },
  approverOpen: { color: colors.success700, fontWeight: '600' },
});

export default E2EGate;
