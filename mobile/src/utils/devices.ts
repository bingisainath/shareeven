// src/utils/devices.ts (same as web/src/utils/devices.ts: keep in sync)
// The account's linked devices as GET /e2e/v2/devices/me reports them: which can approve a new device
// right now, how long ago the others were used, and which have been unused so long they're worth removing.
//
// A device stays linked until someone logs out on it or removes it, even when its browser is closed or
// its storage was wiped (then it can never approve anything). The server marks open apps as seen about
// once a minute over their WebSocket.

export interface LinkedDevice {
  device_id: number;
  name: string;
  last_seen_at: string | null;
  /** Seen in the last few minutes: open right now. */
  active_now?: boolean;
  /** Not seen for 30 days or more. */
  unused?: boolean;
  /** On the account's signed device list (a device still waiting to be linked isn't). */
  linked?: boolean;
}

/** The devices that could approve a new one: linked ones, open ones first, then by last use. */
export function approvers(devices: LinkedDevice[], exceptId?: number | null): LinkedDevice[] {
  return devices
    .filter((d) => d.linked !== false && d.device_id !== exceptId)
    .sort((a, b) => Number(!!b.active_now) - Number(!!a.active_now) || (b.last_seen_at || '').localeCompare(a.last_seen_at || ''));
}

/** Linked devices unused for 30+ days, other than this one: offered for removal. */
export const unusedDevices = (devices: LinkedDevice[], currentId?: number | null): LinkedDevice[] =>
  devices.filter((d) => d.linked !== false && d.unused && d.device_id !== currentId);

/** "Open now", "Active 5 minutes ago", "Active yesterday", "Last active 12 Oct". */
export function lastActive(device: LinkedDevice, now: number = Date.now()): string {
  if (device.active_now) return 'Open now';
  if (!device.last_seen_at) return 'Not used yet';
  const seen = new Date(device.last_seen_at).getTime();
  const minutes = Math.max(1, Math.round((now - seen) / 60000));
  if (minutes < 60) return `Active ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Active ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Active yesterday';
  if (days < 7) return `Active ${days} days ago`;
  return `Last active ${new Date(seen).toLocaleDateString([], { day: 'numeric', month: 'short', ...(days > 300 ? { year: 'numeric' } : {}) })}`;
}
