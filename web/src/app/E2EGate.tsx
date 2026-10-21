// src/app/E2EGate.tsx
// After sign-in, before the chats: make sure this browser has the account's encryption keys.
// - First device on the account: keys are created here silently, nothing to do.
// - Another device already has them: show a QR code; the phone (Settings → End-to-end encryption →
//   Link a device) scans it, or the code under it is typed there. It adds this browser to the account
//   and sends the keys and the message history over, encrypted for this browser alone.
// - No other device available: start fresh with new keys; older encrypted messages can't be read.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertCircle, Smartphone } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { Loading } from '../components/atoms';
import { publicKeysOf } from '../crypto/e2e';
import { e2eSession } from '../crypto/session';
import { linkHere, listStatus, startFreshV2 } from '../crypto/v2-platform/link';
import type { LinkHere } from '../crypto/v2-platform/link';
import { e2eService } from '../services/e2e.service';
import type { MyKeys } from '../services/e2e.service';
import { parseApiError } from '../utils/apiError';
import { startV2 } from '../crypto/v2-platform/runtime';
import { backupIfDue, restoreFromBackup } from '../crypto/backupRuntime';
import { store } from '../redux/store';
import { syncV2 } from '../redux/actions/websocketActions';
import { isRecoveryKey } from '../crypto/backup';
import api from '../utils/axios';
import { DeviceRemovedError } from '../crypto/v2/device';
import { LOGGED_OUT_ELSEWHERE_EVENT } from '../utils/authRefresh';
import { approvers, lastActive } from '../utils/devices';
import type { LinkedDevice } from '../utils/devices';

type Stage = { name: 'checking' } | { name: 'ready' } | { name: 'link'; mine: MyKeys } | { name: 'error'; message: string };

/** "Chrome on Windows" etc., so the phone can show which device is asking. */
export function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export const E2EGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout } = useAuth();
  const [stage, setStage] = useState<Stage>({ name: 'checking' });
  const userId = user?.id;

  const check = useCallback(async () => {
    if (!userId) return;
    setStage({ name: 'checking' });
    try {
      const mine = await e2eService.mine();
      // Version 1 keys from earlier on this browser: only for reading older messages, so optional.
      // Dropped if they were replaced or retired on another device since.
      if (mine.has_keys && (await e2eSession.restore(userId))) {
        if (publicKeysOf(e2eSession.keys()!).enc !== mine.enc_public) await e2eSession.clear();
      } else {
        await e2eSession.clear();
      }
      const hasV1 = !!e2eSession.keys();
      // Registers this browser; the account's first device creates the signed device list (and the account key)
      const status = await listStatus(userId);
      if (status === 'orphaned' && hasV1) {
        // Every device that held the account key has logged out, but this browser has the keys:
        // it becomes the account's first device (contacts see a new security code; nothing is lost)
        await startFreshV2(userId);
      }
      if (status === 'listed' || (status === 'orphaned' && hasV1)) {
        setStage({ name: 'ready' });
        return;
      }
      setStage({ name: 'link', mine });
    } catch (error) {
      // Logged out from another device while this browser stayed signed in: sign out, like any remote logout
      if (error instanceof DeviceRemovedError) {
        window.dispatchEvent(new Event(LOGGED_OUT_ELSEWHERE_EVENT));
        return;
      }
      setStage({ name: 'error', message: parseApiError(error) });
    }
  }, [userId]);

  useEffect(() => { check(); }, [check]);

  // Encryption v2 starts in the background once this browser is ready (registers, uploads prekeys)
  useEffect(() => {
    if (stage.name === 'ready' && userId) {
      startV2(userId)
        .then(() => store.dispatch(syncV2())) // v2 packets that arrived while signed out
        .then(() => backupIfDue(userId))
        .catch((e) => console.warn('Encryption v2 setup or backup failed (will retry next start):', e?.message || e));
    }
  }, [stage.name, userId]);

  // Our keys were replaced on another device: link again
  useEffect(() => e2eSession.onStale(() => { e2eSession.clear().then(check); }), [check]);

  if (stage.name === 'ready') return <>{children}</>;

  if (stage.name === 'checking') {
    return (
      <div className="flex items-center justify-center h-screen bg-muted-50">
        <Loading variant="spinner" size="xl" text="Loading…" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted-50 p-4">
      <div className="bg-white border border-muted-200 rounded-2xl shadow-card p-8 w-full max-w-md">
        {stage.name === 'error' ? (
          <>
            <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-accent-50 flex items-center justify-center">
              <AlertCircle className="w-7 h-7 text-accent-600" strokeWidth={1.75} />
            </div>
            <h1 className="text-2xl font-semibold text-muted-900 text-center">Couldn't check your encryption</h1>
            <p className="mt-2 text-center text-sm text-muted-600">{stage.message}</p>
            <button type="button" onClick={check} className="mt-6 w-full py-3 rounded-lg bg-primary-700 hover:bg-primary-800 text-white font-medium">Try again</button>
          </>
        ) : (
          <LinkThisDevice mine={stage.mine} userId={userId!} onDone={() => setStage({ name: 'ready' })} />
        )}
        <p className="mt-6 text-center text-sm text-muted-500">
          Signed in as <span className="font-medium text-muted-700">{user?.username}</span> ·{' '}
          <button type="button" onClick={logout} className="text-primary-700 hover:underline">Log out</button>
        </p>
      </div>
    </div>
  );
};

/**
 * Which of the account's linked devices can approve this one, and whether any is open right now. A closed
 * browser or a phone with the app shut still counts as linked but can't answer until it's opened again.
 */
const WhoCanApprove: React.FC = () => {
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/v1/e2e/v2/devices/me')
      .then((r) => { if (alive) setDevices(approvers(r.data.data.devices as LinkedDevice[])); })
      .catch(() => undefined);
    load();
    const timer = setInterval(load, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!devices?.length) return null;
  const anyOpen = devices.some((d) => d.active_now);
  return (
    <div className="mt-5 w-full text-left">
      {!anyOpen && (
        <p className="mb-2 p-3 rounded-lg bg-warning-50 text-warning-800 text-xs leading-relaxed" role="status">
          None of your linked devices is open right now. Open ShareEven on one of them to approve this browser (phones also get a notification),
          or choose “Don't have your other device?” below.
        </p>
      )}
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-500">Your linked devices</p>
      <ul className="rounded-lg border border-muted-200 divide-y divide-muted-200">
        {devices.map((d) => (
          <li key={d.device_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="truncate text-muted-800">{d.name}</span>
            <span className={`flex-shrink-0 flex items-center gap-1.5 text-xs ${d.active_now ? 'text-success-700 font-semibold' : 'text-muted-500'}`}>
              {d.active_now && <span className="w-2 h-2 rounded-full bg-success-500" />}
              {lastActive(d)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const LinkThisDevice: React.FC<{ mine: MyKeys; userId: string; onDone: () => void }> = ({ mine, userId, onDone }) => {
  const [link, setLink] = useState<LinkHere | null>(null);
  const [expired, setExpired] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showCode, setShowCode] = useState(false); // the QR / 16-character code instead of one-tap approval
  const [error, setError] = useState('');
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');

  useEffect(() => {
    api.get('/api/v1/e2e/backup').then((r) => setHasBackup(!!r.data.data.exists)).catch(() => undefined);
  }, []);

  const restore = async () => {
    setBusy(true);
    setError('');
    attempt.current += 1; // stop waiting for another device
    try {
      await restoreFromBackup(userId, recoveryKey, mine.enc_public!);
      onDone();
    } catch (err: any) {
      begin(); // keep waiting for another device too (this clears the error, so set it after)
      setError(err?.message || parseApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const attempt = useRef(0);

  const begin = useCallback(async () => {
    const mineAttempt = ++attempt.current;
    setExpired(false);
    setDenied(false);
    setError('');
    setLink(null);
    try {
      const pending = await linkHere(userId, mine.enc_public!, browserName());
      if (mineAttempt !== attempt.current) return;
      setLink(pending);
      const result = await pending.wait(() => mineAttempt !== attempt.current);
      if (mineAttempt !== attempt.current) return;
      if (result === 'expired') {
        setExpired(true);
        return;
      }
      if (result === 'denied') {
        setDenied(true);
        return;
      }
      onDone();
    } catch (err) {
      if (mineAttempt === attempt.current) setError(parseApiError(err));
    }
  }, [mine.enc_public, userId, onDone]);

  useEffect(() => {
    begin();
    return () => { attempt.current += 1; }; // stop waiting when leaving
  }, [begin]);

  const startFresh = async () => {
    setBusy(true);
    attempt.current += 1;
    try {
      // New keys are version 2 only; the old version 1 keys are retired (nobody encrypts to them any more)
      if (mine.has_keys) await e2eService.retireKeys();
      await e2eSession.clear();
      await startFreshV2(userId);
      onDone();
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-primary-50 flex items-center justify-center">
        <Smartphone className="w-7 h-7 text-primary-700" strokeWidth={1.75} />
      </div>
      <h1 className="text-2xl font-semibold text-muted-900 text-center">Link this browser</h1>
      <p className="mt-2 text-center text-sm text-muted-600">
        {link?.number && !showCode
          ? <>Your chats are end-to-end encrypted. Your phone (or other signed-in browser) is asking <b className="text-muted-800">“Is this you?”</b>. Tap this number there:</>
          : <>Your chats are end-to-end encrypted. On a signed-in device, go to <span className="font-medium text-muted-800">Settings → Linked devices → Link a device</span>, and scan this code or type the code below.</>}
      </p>

      <div className="mt-6 flex flex-col items-center">
        {link && !expired && !denied ? (
          <>
            {link.number && !showCode ? (
              <>
                <p className="w-28 h-28 rounded-3xl bg-primary-50 border border-primary-100 grid place-items-center font-display text-6xl font-bold text-primary-700 tabular-nums"
                  aria-label={`Number to pick on your other device: ${link.number}`} data-testid="link-number">{link.number}</p>
                <p className="mt-3 text-xs text-muted-500 text-center">Don't see it? Open ShareEven on your other device.</p>
              </>
            ) : (
              <>
                <div className="p-3 bg-white border border-muted-200 rounded-xl" aria-label="Link code QR">
                  <QRCodeSVG value={link.qrText} size={200} level="M" />
                </div>
                <p className="mt-4 text-xs text-muted-500">Or type this code on the other device</p>
                <p className="mt-1 font-mono text-lg tracking-wider text-muted-900" data-testid="link-code">{link.code}</p>
              </>
            )}
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-500">
              <span className="w-3 h-3 rounded-full border-2 border-primary-200 border-t-primary-700 animate-spin" /> Waiting for your other device…
            </p>
            {link.number && (
              <button type="button" onClick={() => setShowCode((s) => !s)} className="mt-3 text-sm font-semibold text-primary-700 hover:underline">
                {showCode ? 'Approve with one tap instead' : 'Use a code instead'}
              </button>
            )}
            <WhoCanApprove />
          </>
        ) : denied ? (
          <div className="text-center">
            <p className="text-sm text-muted-600">This was turned down on your other device.</p>
            <button type="button" onClick={begin} className="mt-3 px-4 py-2 rounded-lg bg-primary-700 text-white text-sm font-medium">Try again</button>
          </div>
        ) : expired ? (
          <div className="text-center">
            <p className="text-sm text-muted-600">The code expired.</p>
            <button type="button" onClick={begin} className="mt-3 px-4 py-2 rounded-lg bg-primary-700 text-white text-sm font-medium">Show a new code</button>
          </div>
        ) : !error && (
          <span className="w-8 h-8 rounded-full border-2 border-primary-200 border-t-primary-700 animate-spin" />
        )}
        {error && (
          <div className="mt-4 w-full p-3 bg-accent-50 border border-accent-200 rounded-lg flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-accent-600 flex-shrink-0" />
            <div className="text-sm text-accent-700">
              {error}{' '}
              <button type="button" onClick={begin} className="font-medium underline">Try again</button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 text-center text-sm">
        {confirmFresh && hasBackup && (
          <div className="mb-3 p-3 rounded-lg border border-muted-200 text-left">
            <p className="text-sm font-medium text-muted-900">Restore from your backup</p>
            <p className="text-xs text-muted-500">Enter the 64-digit recovery key you saved when you turned on backups.</p>
            <input value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="1234 5678 …" aria-label="Recovery key"
              className="mt-2 w-full px-3 py-2 rounded-lg border border-muted-300 font-mono text-sm" />
            <button type="button" onClick={restore} disabled={busy || !isRecoveryKey(recoveryKey)}
              className="mt-2 w-full py-2 rounded-lg bg-primary-700 text-white text-sm font-medium disabled:opacity-50">
              {busy ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        )}
        {confirmFresh ? (
          <div className="p-3 rounded-lg bg-warning-50 text-warning-800 text-left">
            <p>Starting fresh creates new keys. Your encrypted messages from before can't be read again, on any device, and the people you chat with will see that your keys changed.</p>
            <div className="mt-2 flex gap-3">
              <button type="button" onClick={startFresh} disabled={busy} className="font-medium text-accent-700 hover:underline">{busy ? 'Starting…' : 'Start fresh'}</button>
              <button type="button" onClick={() => setConfirmFresh(false)} className="text-muted-600 hover:underline">Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmFresh(true)} className="text-primary-700 hover:underline">Don't have your other device?</button>
        )}
      </div>
    </>
  );
};

export default E2EGate;
