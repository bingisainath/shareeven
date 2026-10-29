// src/store/auth.ts
// Who is signed in. Tokens are kept in secure storage, so the session survives restarts.

import { create } from 'zustand';
import axios from 'axios';
import { authApi, TokenPair, User } from '../api/auth';
import { errorMessage, setSessionExpiredHandler } from '../api/client';
import { tokens } from '../api/tokens';
import { socket } from '../websocket/socket';
import { clearAllNotifications, disablePush, enablePush } from '../notifications/push';
import { e2eSession } from '../crypto/session';
import { stopV2, v2Runtime } from '../crypto/v2-platform/runtime';
import { showAlert } from '../components/common/Dialog';
import { forgetRecoveryKey } from '../crypto/savedRecoveryKey';
import { chatDrafts } from '../utils/drafts';
import { appCache } from '../utils/appCache';
import { useNotices } from './notices';

type Status = 'loading' | 'signedOut' | 'signedIn';

export class NeedsVerification extends Error {
  constructor(public email: string, message: string) {
    super(message);
  }
}

interface AuthState {
  status: Status;
  user: User | null;
  restore: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  /** Rejects with error.suggestion set when the email looks mistyped ("Did you mean …?"). */
  register: (username: string, email: string, password: string, emailTypoChecked?: boolean) => Promise<void>;
  verifyEmail: (identifier: string, code: string) => Promise<void>;
  resendCode: (identifier: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: User) => void;
  logout: () => Promise<void>;
  /** The account was deleted (here or on another device): sign out and wipe this phone. */
  accountDeleted: () => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => {
  const finishSignIn = async (pair: TokenPair) => {
    await tokens.save(pair.access_token, pair.refresh_token ?? null);
    const user = await authApi.me();
    appCache.saveUser(user);
    set({ user, status: 'signedIn' });
    socket.start();
    enablePush();
  };

  // The server turned this account down. (A 401 that renewing the token couldn't fix already signed out
  // through the session-expired handler, unless renewing only failed to connect: then carry on.)
  const rejected = (error: unknown) => axios.isAxiosError(error) && error.response?.status === 403;

  // Logged out from another device: wipe this one's keys and messages, like logging out here
  const loggedOutElsewhere = async () => {
    socket.stop();
    await stopV2().catch(() => undefined);
    await e2eSession.clear();
    await chatDrafts.clearAll();
    await appCache.clearAll();
    useNotices.getState().clear();
    set({ user: null, status: 'signedOut' });
  };

  setSessionExpiredHandler((loggedOut) => {
    if (loggedOut) {
      loggedOutElsewhere().catch(() => undefined);
      return;
    }
    socket.stop();
    appCache.clearAll();
    set({ user: null, status: 'signedOut' });
  });

  // Register for notifications whenever the server is reachable again (a start while offline skipped it)
  socket.onStatus((connected) => {
    if (connected && get().status === 'signedIn') enablePush({ ask: false });
  });

  // The account is gone: its recovery key saved on this phone goes too
  const forgetSavedKey = async () => {
    const id = get().user?.id;
    if (id) await forgetRecoveryKey(id);
  };

  // The account was deleted from one of its devices: every device signs out and wipes itself
  socket.on((e) => {
    if (e.type === 'account_deleted') forgetSavedKey().then(() => tokens.clear()).then(loggedOutElsewhere).catch(() => undefined);
  });

  // Suspended by an admin: sign out but keep this phone's keys (nothing is lost if it's lifted);
  // signing in again says why and until when
  socket.on((e) => {
    if (e.type !== 'account_suspended') return;
    tokens.clear().then(() => {
      socket.stop();
      appCache.clearAll();
      set({ user: null, status: 'signedOut' });
      showAlert('Your account was suspended', 'Try signing in to see why and until when.');
    }).catch(() => undefined);
  });

  // Online when it happens: the server says which device was logged out
  socket.on((e) => {
    if (e.type !== 'session_revoked') return;
    const running = v2Runtime();
    if (!running) return;
    running.then((r) => {
      if (r.state.deviceId === e.deviceId) {
        tokens.clear().then(loggedOutElsewhere).catch(() => undefined);
      }
    }).catch(() => undefined);
  });

  return {
    status: 'loading',
    user: null,

    restore: async () => {
      if (!(await tokens.load())) {
        set({ status: 'signedOut' });
        return;
      }
      const saved = await appCache.user();
      if (saved) {
        // Open straight away as last time, and check the sign-in with the server meanwhile
        set({ user: saved, status: 'signedIn' });
        socket.start();
        enablePush();
        authApi.me().then((user) => {
          if (get().status !== 'signedIn') return;
          set({ user });
          appCache.saveUser(user);
        }).catch(async (error) => {
          if (!rejected(error) || get().status !== 'signedIn') return; // offline or a server hiccup: carry on
          socket.stop();
          await tokens.clear();
          set({ user: null, status: 'signedOut' });
        });
        return;
      }
      try {
        const user = await authApi.me();
        appCache.saveUser(user);
        set({ user, status: 'signedIn' });
        socket.start();
        enablePush();
      } catch (error) {
        // Offline: keep the session and try again later; rejected: sign out
        if (axios.isAxiosError(error) && !error.response) {
          set({ status: 'signedIn' });
          socket.start();
        } else {
          await tokens.clear();
          set({ status: 'signedOut' });
        }
      }
    },

    login: async (identifier, password) => {
      try {
        await finishSignIn(await authApi.login(identifier.trim(), password));
      } catch (error) {
        const body = axios.isAxiosError(error) ? (error.response?.data as any) : undefined;
        if (body?.code === 'email_not_verified') {
          authApi.resendCode(body.data?.email).catch(() => undefined);
          throw new NeedsVerification(body.data?.email, errorMessage(error));
        }
        throw new Error(errorMessage(error));
      }
    },

    register: async (username, email, password, emailTypoChecked = false) => {
      try {
        await authApi.register(username.trim().toLowerCase(), email.trim().toLowerCase(), password, emailTypoChecked);
      } catch (error) {
        const body = axios.isAxiosError(error) ? (error.response?.data as { code?: string; data?: { suggestion?: string } } | undefined) : undefined;
        throw Object.assign(new Error(errorMessage(error)), body?.code === 'email_typo' ? { suggestion: body.data?.suggestion } : {});
      }
    },

    verifyEmail: async (identifier, code) => {
      try {
        await finishSignIn(await authApi.verifyEmail(identifier, code));
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },

    resendCode: async (identifier) => {
      try {
        await authApi.resendCode(identifier);
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },

    refreshUser: async () => {
      const user = await authApi.me();
      appCache.saveUser(user);
      set({ user });
    },

    setUser: (user) => { appCache.saveUser(user); set({ user }); },
    accountDeleted: async () => {
      await forgetSavedKey();
      await tokens.clear();
      await loggedOutElsewhere();
    },

    logout: async () => {
      await disablePush(); // while still signed in, so the server accepts it
      clearAllNotifications();
      await stopV2().catch(() => undefined); // v2: the server forgets this device; local data is wiped
      socket.stop();
      await tokens.clear();
      await e2eSession.clear(); // signing in here again means linking it again
      await chatDrafts.clearAll(); // unsent text goes with the sign-in
      await appCache.clearAll(); // so does what the app showed last time
      useNotices.getState().clear();
      set({ user: null, status: 'signedOut' });
    },
  };
});
