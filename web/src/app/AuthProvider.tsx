
// src/app/AuthProvider.tsx - WITH WEBSOCKET INTEGRATION

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useDispatch } from "react-redux";
import { authService, loginUser, registerUser, getMe, updateMe, verifyEmailCode, resendVerificationCode } from "../services/auth.service";
import { AxiosError } from "axios";
import type { ProfileUpdate } from "../services/auth.service";
import { User } from "../types/auth.types";
import { decodeJwt, isTokenExpired, TOKEN_STORAGE_KEY, tokenStore } from "../utils/token";
import { e2eSession } from "../crypto/session";
import { stopV2 } from "../crypto/v2-platform/runtime";
import { ACCOUNT_DELETED_EVENT, ACCOUNT_SUSPENDED_EVENT, LOGGED_OUT_ELSEWHERE_EVENT, refreshAccessToken, SESSION_EXPIRED_EVENT } from "../utils/authRefresh";
import { toast } from "react-toastify";
import { chatDrafts } from "../utils/drafts";
import { clearNotices } from '../hooks/useNotices';
import { parseApiError } from "../utils/apiError";
import { connectWebSocket, disconnectWebSocket } from "../redux/actions/websocketActions";
import { whenActiveTab } from "../utils/activeTab";
import type { AppDispatch } from "../redux/store";

type ApiEnvelope<T> = { success: boolean; message?: string; data?: T };

function unwrap<T>(res: any): ApiEnvelope<T> {
  if (res && typeof res === "object" && "success" in res)
    return res as ApiEnvelope<T>;
  return { success: true, data: res as T };
}

type AuthContextType = {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  // login: (email: string, password: string) => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  /** Rejects with error.suggestion set when the email looks mistyped ("Did you mean …?"). */
  register: (u: string, e: string, p: string, emailTypoChecked?: boolean) => Promise<void>;
  verifyEmail: (identifier: string, code: string) => Promise<void>;
  resendCode: (identifier: string) => Promise<void>;
  /** Resolves to the account's partly hidden email (where the link went). */
  forgotPassword: (identifier: string) => Promise<string>;
  verifyResetToken: (token: string) => Promise<{ email: string; username: string }>;
  resetPassword: (token: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void> | void;
  clearError: () => void;
  updateProfile: (data: ProfileUpdate) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dispatch = useDispatch<AppDispatch>();

  const clearError = useCallback(() => setError(null), []);

  // Chat code reads the current user from localStorage (sender id, own-message checks)
  useEffect(() => {
    if (user) {
      localStorage.setItem("userId", user.id);
      localStorage.setItem("username", user.username);
      if (user.avatar) localStorage.setItem("userAvatar", user.avatar);
      else localStorage.removeItem("userAvatar");
    } else {
      localStorage.removeItem("userId");
      localStorage.removeItem("username");
      localStorage.removeItem("userAvatar");
    }
  }, [user]);

  // Only the active tab keeps the live connection (see utils/activeTab); others wait for "Use here"
  const connectWhenActive = useCallback((token: string) => {
    whenActiveTab().then(() => {
      if (tokenStore.get()) dispatch(connectWebSocket(tokenStore.get() || token)); // still signed in
    });
  }, [dispatch]);

  const logout = useCallback(async () => {
    // ✅ ADD: Disconnect WebSocket before logout
    dispatch(disconnectWebSocket());

    // v2: the server forgets this device and its local data is wiped (while still signed in)
    await stopV2().catch(() => undefined);
    tokenStore.clear();
    e2eSession.clear(); // signing in here again means linking it again
    chatDrafts.clearAll(); // unsent text stays with the person, not the browser
    clearNotices();
    setUser(null);
    setError(null);
  }, [dispatch]);


  // Tabs share one sign-in (localStorage). Logging out in another tab ends this one too, and a
  // different account signing in there reloads this tab, so it never shows the old account's data.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || (e.key !== null && e.key !== TOKEN_STORAGE_KEY)) return;
      const token = tokenStore.get();
      if (!token) {
        if (!user) return;
        // The other tab already told the server and wiped this browser's keys: just stop here
        dispatch(disconnectWebSocket());
        stopV2(false).catch(() => undefined);
        e2eSession.clear();
        clearNotices();
        setUser(null);
        toast.info("You logged out in another tab.");
        return;
      }
      // (A tab still restoring its own session picks the new sign-in up by itself)
      const sub = decodeJwt(token)?.sub;
      if (sub && (user ? sub !== user.id : !isLoading)) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [user, isLoading, dispatch]);

  // Renew the access token shortly before it expires, for as long as we're logged in
  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const exp = decodeJwt(tokenStore.get() || "")?.exp;
      const msLeft = exp ? exp * 1000 - Date.now() : 0;
      timer = setTimeout(async () => {
        if (await refreshAccessToken()) schedule();
      }, Math.max(msLeft - 60_000, 5_000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [user]);

  // The refresh token was rejected (expired, password changed, ...): end the session
  useEffect(() => {
    const onExpired = () => {
      if (!tokenStore.get()) {
        logout();
        toast.info("Your session expired. Please log in again.");
      }
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    // Logged out from another device: logging out here also wipes this browser's keys and messages
    const onLoggedOut = () => {
      tokenStore.clear();
      logout();
      toast.info("This browser was logged out from another of your devices.");
    };
    window.addEventListener(LOGGED_OUT_ELSEWHERE_EVENT, onLoggedOut);
    const onDeleted = () => {
      tokenStore.clear();
      logout();
      toast.info("Your ShareEven account was deleted.");
    };
    window.addEventListener(ACCOUNT_DELETED_EVENT, onDeleted);
    const onSuspended = () => {
      tokenStore.clear();
      logout();
      toast.error("Your account was suspended. Try logging in to see why and until when.", { autoClose: false });
    };
    window.addEventListener(ACCOUNT_SUSPENDED_EVENT, onSuspended);
    return () => {
      window.removeEventListener(ACCOUNT_SUSPENDED_EVENT, onSuspended);
      window.removeEventListener(ACCOUNT_DELETED_EVENT, onDeleted);
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener(LOGGED_OUT_ELSEWHERE_EVENT, onLoggedOut);
    };
  }, [logout]);

  useEffect(() => {
    const init = async () => {
      try {
        let token = tokenStore.get();
        if (!token || isTokenExpired(token)) {
          // Access token gone or expired: try to renew it before giving up
          token = await refreshAccessToken();
          if (!token) {
            logout();
            return;
          }
        }

        const res = unwrap<User>(await getMe());
        if (!res.success || !res.data) {
          logout();
          return;
        }

        setUser(res.data);

        connectWhenActive(token);

      } catch (err) {
        console.error("[AUTH] Session restore failed:", err);
        logout();
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [logout, connectWhenActive]);

  // Store the tokens, load the profile and open the live connection
  const finishSignIn = useCallback(
    async (tokens: { access_token: string; refresh_token?: string }) => {
      tokenStore.set(tokens.access_token);
      if (tokens.refresh_token) tokenStore.setRefresh(tokens.refresh_token);
      const meRes = unwrap<User>(await getMe());
      if (!meRes.success || !meRes.data) {
        throw new Error(meRes.message || "Unable to fetch user profile");
      }
      setUser(meRes.data);
      setError(null);
      connectWhenActive(tokens.access_token);
    },
    [connectWhenActive]
  );

  /** Check the emailed 6-digit code; signs the person in on success. */
  const verifyEmail = useCallback(
    async (identifier: string, code: string): Promise<void> => {
      try {
        const res = unwrap<{ access_token: string; refresh_token?: string }>(
          await verifyEmailCode({ identifier, code })
        );
        if (!res.success || !res.data?.access_token) throw new Error(res.message || "Verification failed");
        await finishSignIn(res.data);
      } catch (err) {
        throw new Error(parseApiError(err));
      }
    },
    [finishSignIn]
  );

  const resendCode = useCallback(async (identifier: string): Promise<void> => {
    try {
      await resendVerificationCode({ identifier });
    } catch (err) {
      throw new Error(parseApiError(err));
    }
  }, []);

  const login = useCallback(
    async (identifier: string, password: string): Promise<void> => {
      setError(null);
      setIsLoading(true);


      try {
        // Validate inputs
        if (!identifier.trim()) throw new Error("Username or email is required");
        if (!password.trim()) throw new Error("Password is required");

        // ✅ CHANGED: Use identifier instead of email
        const res = unwrap<{ access_token: string; refresh_token?: string; token_type: string }>(
          await loginUser({ identifier, password })
        );

        // Backend returned success=false
        if (!res.success) {
          throw new Error(res.message || "Login failed");
        }

        if (!res.data?.access_token) {
          throw new Error("No access token received");
        }

        await finishSignIn(res.data);
      } catch (err) {
        const msg = parseApiError(err);
        setError(msg);
        // Account exists but its email isn't confirmed yet: the caller shows the code screen
        const body = err instanceof AxiosError ? err.response?.data : undefined;
        if (body?.code === "email_not_verified") {
          throw Object.assign(new Error(msg), { code: "email_not_verified", email: body.data?.email as string });
        }
        throw new Error(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [finishSignIn]
  );

  const register = useCallback(
    async (username: string, email: string, password: string, emailTypoChecked = false): Promise<void> => {
      setError(null);
      setIsLoading(true);

      try {
        // Validate inputs
        if (!username.trim()) throw new Error("Username is required");
        if (!email.trim()) throw new Error("Email is required");
        if (!password.trim()) throw new Error("Password is required");

        if (username.length < 3) {
          throw new Error("Username must be at least 3 characters");
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error("Please enter a valid email address");
        }

        if (password.length < 6) {
          throw new Error("Password must be at least 6 characters");
        }

        const res = unwrap<User>(
          await registerUser({ username, email, password, email_typo_checked: emailTypoChecked })
        );

        if (!res.success) {
          throw new Error(res.message || "Registration failed");
        }

        setError(null);

        // Note: No WebSocket connection here - user needs to login first

      } catch (err) {
        const msg = parseApiError(err);
        setError(msg);
        console.error("[AUTH] ❌ REGISTER ERROR:", msg);
        const body = (err as any)?.response?.data;
        throw Object.assign(new Error(msg), body?.code === "email_typo" ? { suggestion: body.data?.suggestion as string } : {});
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const forgotPassword = useCallback(
    async (identifier: string): Promise<string> => {
      setError(null);
      setIsLoading(true);
      try {
        if (!identifier.trim()) {
          throw new Error("Username or email is required");
        }

        const response = await authService.forgotPassword(identifier);

        if (!response.success) {
          throw new Error(response.message || "Failed to send reset email");
        }
        return response.data?.email || identifier;

      } catch (err) {
        const msg = parseApiError(err);
        setError(msg);
        console.error("[AUTH] ❌ FORGOT PASSWORD ERROR:", msg);
        throw new Error(msg);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const verifyResetToken = useCallback(
    async (token: string): Promise<{ email: string; username: string }> => {
      setError(null);
      setIsLoading(true);

      try {
        const response = await authService.verifyResetToken(token);

        if (!response.success || !response.data) {
          throw new Error(response.message || "Invalid or expired token");
        }

        return {
          email: response.data.email,
          username: response.data.username
        };

      } catch (err) {
        const msg = parseApiError(err);
        setError(msg);
        console.error("[AUTH] ❌ VERIFY TOKEN ERROR:", msg);
        throw new Error(msg);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const resetPassword = useCallback(
    async (token: string, newPassword: string): Promise<void> => {
      setError(null);
      setIsLoading(true);

      try {
        if (!newPassword.trim()) {
          throw new Error("Password is required");
        }

        if (newPassword.length < 6) {
          throw new Error("Password must be at least 6 characters");
        }

        const response = await authService.resetPassword(token, newPassword);

        if (!response.success) {
          throw new Error(response.message || "Failed to reset password");
        }


      } catch (err) {
        const msg = parseApiError(err);
        setError(msg);
        console.error("[AUTH] ❌ RESET PASSWORD ERROR:", msg);
        throw new Error(msg);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const updateProfile = useCallback(async (data: ProfileUpdate): Promise<void> => {
    const res = unwrap<User>(await updateMe(data));
    if (!res.success || !res.data) {
      throw new Error(res.message || "Profile update failed");
    }
    setUser(res.data);
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: !!user,
      isLoading,
      error,
      login,
      register,
      verifyEmail,
      resendCode,
      logout,
      clearError,
      updateProfile,
      forgotPassword,    
      verifyResetToken,    
      resetPassword,        
    }),
    [user, isLoading, error, login, register, verifyEmail, resendCode, logout, clearError, updateProfile, forgotPassword, verifyResetToken, resetPassword]
  );

return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};