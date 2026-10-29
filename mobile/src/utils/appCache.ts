// src/utils/appCache.ts
// What the app showed last time (your profile and the chat list), so opening it again shows them
// straight away while the server is asked for fresh copies. Kept on this phone only, in its own
// SQLCipher-encrypted database (same protection as drafts and decrypted messages), and wiped on logout.

import { openSqliteKV } from '../crypto/v2-platform/sqliteKV';
import type { KV } from '../crypto/v2/storage';
import type { User } from '../api/auth';
import type { Conversation } from '../api/chat';

let db: Promise<KV> | null = null;
const store = () => (db ??= openSqliteKV('shareeven-cache.sqlite').catch((e) => { db = null; throw e; }));

const USER = 'user';
const chatsKey = (userId: string) => `chats:${userId}`;

async function read<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await store()).get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const write = (key: string, value: unknown) =>
  store().then((kv) => kv.write([[key, value === null ? null : JSON.stringify(value)]])).catch(() => undefined);

let chatsTimer: ReturnType<typeof setTimeout> | null = null;

export const appCache = {
  user: () => read<User>(USER),
  saveUser: (user: User) => write(USER, user),

  chats: (userId: string) => read<Conversation[]>(chatsKey(userId)),
  /** Saved shortly after the list settles (not on every typing or online change). */
  saveChats(userId: string, conversations: Conversation[]): void {
    if (chatsTimer) clearTimeout(chatsTimer);
    chatsTimer = setTimeout(() => { chatsTimer = null; write(chatsKey(userId), conversations); }, 1000);
  },

  /** Logout, or the account is gone. */
  async clearAll(): Promise<void> {
    if (chatsTimer) clearTimeout(chatsTimer);
    chatsTimer = null;
    await store().then((kv) => kv.clear()).catch(() => undefined);
  },
};
