// This device's v2 setup and upkeep (docs/encryption-design-v2.md §2, §3, phase 3):
// - register its identity keys with the server (once);
// - keep a signed prekey that's at most 7 days old (old ones kept 30 days for late first messages);
// - keep at least 25 one-time prekeys on the server, refilling to 100;
// - the account's first v2 device becomes the primary: it creates the account key and publishes the
//   signed device list. Other devices are added by linking (accountLink.ts).

import { b64 } from './primitives';
import { certifyDevice, loadDeviceIdentity, newAccountIdentity, newDeviceIdentity, signDeviceList, storeDeviceIdentity } from './identity';
import type { DeviceList, DevicePublic } from './identity';
import {
  newOneTimePreKeys, newSignedPreKey, ONE_TIME_PREKEY_BATCH, ONE_TIME_PREKEY_REFILL_BELOW, publicOneTimePreKeys, publicSignedPreKey,
  SIGNED_PREKEY_KEEP_MS, SIGNED_PREKEY_ROTATION_MS,
} from './prekeys';
import type { EncryptedStore } from './storage';
import { leaveDeviceList, serverTime } from './accountLink';

/** The apps' HTTP client, returning each response's `data` field. Paths are relative to /api/v1. */
export interface E2EHttp {
  get<T>(path: string, params?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

/** True for an HTTP error with this status (axios-style errors). */
export const httpStatus = (e: unknown): number | undefined => (e as { response?: { status?: number } })?.response?.status;

/**
 * The server couldn't be reached or failed for a moment (axios-style error with no response, or a 5xx/429):
 * worth trying again later. Phones block an app's network in the background while its WebSocket still delivers.
 */
export const isTransientHttpError = (e: unknown): boolean => {
  if (!(e as { isAxiosError?: boolean })?.isAxiosError) return false;
  const status = httpStatus(e);
  return status === undefined || status >= 500 || status === 429;
};

/**
 * This device was removed from the account on another device ("Log out this device") while this one
 * stayed signed in. Its local keys are wiped; the app should sign out, as if logged out remotely.
 */
export class DeviceRemovedError extends Error {
  constructor() {
    super('This device was logged out from another of your devices');
    this.name = 'DeviceRemovedError';
  }
}

export interface DeviceState {
  deviceId: number;
  primary: boolean;
  listed: boolean;
}

export class DeviceManager {
  constructor(
    private store: EncryptedStore,
    private http: E2EHttp,
    private userId: string,
    private deviceName: string,
    private now: () => number = () => Date.now(),
  ) {}

  /** Make sure this device is registered, has fresh prekeys, and (if it's the first) the account is set up. */
  async bootstrap(): Promise<DeviceState> {
    let device = await this.store.device();
    if (device && device.userId !== this.userId) {
      await this.store.wipe(); // a different account signed in on this device
      device = null;
    }
    if (!device) {
      const identity = newDeviceIdentity();
      device = { userId: this.userId, deviceId: null, identity: storeDeviceIdentity(identity), primary: false, listed: false };
      await this.store.saveDevice(device);
    }
    if (device.deviceId === null) {
      const identity = loadDeviceIdentity(device.identity);
      const registered = await this.http.post<{ device_id: number }>('/e2e/v2/devices', {
        sign: b64(identity.sign.pub), dh: b64(identity.dh.pub), dhSig: b64(identity.dhSig), name: this.deviceName,
      });
      device = { ...device, deviceId: registered.device_id };
      await this.store.saveDevice(device);
    }
    try {
      await this.ensurePrekeys();
    } catch (e) {
      // The server doesn't know our device number any more: it was removed elsewhere
      if (httpStatus(e) === 404) {
        await this.store.wipe();
        throw new DeviceRemovedError();
      }
      // A device that's already set up still opens offline (or while the server has a moment); its
      // prekeys are topped up the next time the app comes to the foreground
      if (!(device.listed && isTransientHttpError(e))) throw e;
    }

    if (!device.listed) {
      const list = await this.currentList();
      if (!list) {
        // First v2 device of this account: it becomes the primary and holds the account key
        const aik = (await this.store.accountKey()) || newAccountIdentity();
        await this.store.saveAccountKey(aik);
        const me = await this.certifySelf(aik.priv);
        const published = await this.http.put<{ server_time?: string } | undefined>('/e2e/v2/device-list', { device_list: signDeviceList(aik, this.userId, 1, [me]) });
        device = { ...device, primary: true, listed: true };
        await this.store.saveDevice(device);
        await this.store.saveSetting('joinedAt', serverTime(published));
      } else if (list.devices.some((d) => d.id === device!.deviceId && d.sign === b64(loadDeviceIdentity(device!.identity).sign.pub))) {
        device = { ...device, listed: true };
        await this.store.saveDevice(device);
      }
    }
    return { deviceId: device.deviceId!, primary: device.primary, listed: device.listed };
  }

  /** Rotate the signed prekey when it's old, and refill one-time prekeys when they run low. */
  async ensurePrekeys(): Promise<void> {
    const device = await this.store.device();
    if (!device?.deviceId) return;
    const identity = loadDeviceIdentity(device.identity);
    const status = await this.http.get<{ one_time_left: number; signed_prekey: { id: number; created_at: string } | null }>(`/e2e/v2/devices/${device.deviceId}/prekeys`);
    const upload: { signedPreKey?: unknown; oneTimePreKeys?: unknown[] } = {};

    const local = (await this.store.signedPreKeys()).sort((a, b) => b.created - a.created);
    let newest = local[0];
    if (!newest || this.now() - newest.created > SIGNED_PREKEY_ROTATION_MS) {
      const spk = newSignedPreKey(identity, await this.store.nextId('spk'), this.now());
      await this.store.saveSignedPreKey(spk.id, spk.key, b64(spk.sig), spk.created);
      upload.signedPreKey = publicSignedPreKey(spk);
      newest = { id: spk.id, created: spk.created };
    } else if (status.signed_prekey?.id !== newest.id) {
      upload.signedPreKey = await this.store.signedPreKeyPublic(newest.id); // the server doesn't have it yet
    }
    // Old signed prekeys answer late first messages for a while, then go
    for (const k of local) {
      if (k.id !== newest.id && this.now() - k.created > SIGNED_PREKEY_KEEP_MS) await this.store.removeSignedPreKey(k.id);
    }

    if (status.one_time_left < ONE_TIME_PREKEY_REFILL_BELOW) {
      const count = ONE_TIME_PREKEY_BATCH - status.one_time_left;
      const first = await this.store.nextId('opk', count);
      const keys = newOneTimePreKeys(first, count);
      await this.store.saveOneTimePreKeys(keys);
      upload.oneTimePreKeys = publicOneTimePreKeys(keys);
    }
    if (upload.signedPreKey || upload.oneTimePreKeys) {
      await this.http.put(`/e2e/v2/devices/${device.deviceId}/prekeys`, upload);
    }
  }

  /** Log this device out: the server forgets it, and everything stored locally is wiped. */
  async logout(): Promise<void> {
    await leaveDeviceList(this.store, this.http, this.userId).catch(() => undefined);
    const device = await this.store.device();
    if (device?.deviceId) await this.http.del(`/e2e/v2/devices/${device.deviceId}`).catch(() => undefined);
    await this.store.wipe();
  }

  private async currentList(): Promise<DeviceList | null> {
    try {
      return await this.http.get<DeviceList>(`/e2e/v2/users/${this.userId}/device-list`);
    } catch (e) {
      if (httpStatus(e) === 404) return null;
      throw e;
    }
  }

  private async certifySelf(aikPriv: Uint8Array): Promise<DevicePublic> {
    const device = (await this.store.device())!;
    const identity = loadDeviceIdentity(device.identity);
    return certifyDevice(aikPriv, this.userId, device.deviceId!, { sign: identity.sign.pub, dh: identity.dh.pub, dhSig: identity.dhSig }, this.now());
  }
}
