import { JwtPayload } from "../types/auth.types";

const STORAGE_KEY =
  process.env.REACT_APP_TOKEN_STORAGE_KEY || "papyris_access_token";
/** The access token's localStorage key (other tabs watch it to follow sign-in and logout). */
export const TOKEN_STORAGE_KEY = STORAGE_KEY;

const REFRESH_STORAGE_KEY = `${STORAGE_KEY}_refresh`;

export const tokenStore = {
  get(): string | null {
    return localStorage.getItem(STORAGE_KEY);
  },
  set(token: string) {
    localStorage.setItem(STORAGE_KEY, token);
  },
  getRefresh(): string | null {
    return localStorage.getItem(REFRESH_STORAGE_KEY);
  },
  setRefresh(token: string) {
    localStorage.setItem(REFRESH_STORAGE_KEY, token);
  },
  clear() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(REFRESH_STORAGE_KEY);
  },
};

export function decodeJwt(token: string): JwtPayload | null {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded as JwtPayload;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string, skewSeconds = 15): boolean {
  const payload = decodeJwt(token);
  if (!payload?.exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return payload.exp <= now + skewSeconds;
}
