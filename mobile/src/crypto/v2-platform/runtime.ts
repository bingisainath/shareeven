// src/crypto/v2-platform/runtime.ts
// Starts encryption v2 for the signed-in account on this phone, in the background: the device
// registers its keys and keeps prekeys topped up; linking and messaging use it (phases 3-5).

import { AppState } from 'react-native';
import { api } from '../../api/client';
import { DeviceManager, EncryptedStore, Messenger } from '../v2';
import type { DeviceState, E2EHttp } from '../v2';
import type { KV } from '../v2/storage';
import { openSqliteKV } from './sqliteKV';
import { phoneName } from '../../utils/device';

export const http: E2EHttp = {
  get: async (path, params) => (await api.get(path, { params })).data.data,
  post: async (path, body) => (await api.post(path, body)).data.data,
  put: async (path, body) => (await api.put(path, body)).data.data,
  del: async (path) => (await api.delete(path)).data.data,
};

interface Runtime { userId: string; store: EncryptedStore; manager: DeviceManager; state: DeviceState; messenger: Messenger }

let current: Promise<Runtime> | null = null;
let stopWatching: (() => void) | null = null;
// One connection to the encrypted database, shared by every start (a second one would skip the store's lock)
let database: Promise<KV> | null = null;
const openDatabase = () => (database ??= openSqliteKV().catch((e) => { database = null; throw e; }));

export function startV2(userId: string): Promise<Runtime> {
  if (current) {
    return current.then((r) => (r.userId === userId ? r : stopV2(false).then(() => startV2(userId))));
  }
  current = (async () => {
    const store = new EncryptedStore(await openDatabase());
    const manager = new DeviceManager(store, http, userId, phoneName());
    const state = await manager.bootstrap();
    // Top up prekeys whenever the app comes back to the foreground
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') manager.ensurePrekeys().catch(() => undefined);
    });
    stopWatching = () => sub.remove();
    const messenger = new Messenger(store, http, { user: userId, device: state.deviceId });
    return { userId, store, manager, state, messenger };
  })();
  current.catch(() => { current = null; }); // try again next time
  return current;
}

/** On logout: forget this device on the server and wipe its local keys and messages. */
export async function stopV2(logout = true): Promise<void> {
  const running = current;
  current = null;
  stopWatching?.();
  stopWatching = null;
  if (!running) return;
  const r = await running.catch(() => null);
  if (r && logout) await r.manager.logout();
}

export const v2Runtime = (): Promise<Runtime> | null => current;

/**
 * For work in the background (a notification arriving while the app is closed): start v2 only if this
 * phone is already set up for this account. Never registers or links a device; that happens in the app.
 */
export async function startV2IfSetUp(userId: string): Promise<Runtime | null> {
  if (current) return startV2(userId);
  return (await isSetUpHere(userId)) ? startV2(userId) : null;
}

/** This phone was already linked to this account and is on its device list (checked on the phone only). */
export async function isSetUpHere(userId: string): Promise<boolean> {
  const device = await new EncryptedStore(await openDatabase()).device();
  return !!device?.listed && device.userId === userId && device.deviceId !== null;
}
