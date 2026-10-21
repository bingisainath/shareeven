import { approvers, lastActive, unusedDevices } from './devices';
import type { LinkedDevice } from './devices';

const now = new Date('2026-10-21T12:00:00Z').getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const d = (device_id: number, over: Partial<LinkedDevice> = {}): LinkedDevice =>
  ({ device_id, name: `Device ${device_id}`, last_seen_at: ago(DAY), linked: true, ...over });

it('asks only linked devices other than this one, open ones first', () => {
  const list = [d(1, { last_seen_at: ago(3 * DAY) }), d(2, { active_now: true, last_seen_at: ago(MIN) }), d(3, { linked: false }), d(4)];
  expect(approvers(list, 4).map((x) => x.device_id)).toEqual([2, 1]);
});

it('offers removal of devices unused for 30 days, never this one', () => {
  const list = [d(1, { unused: true }), d(2, { unused: true }), d(3), d(4, { unused: true, linked: false })];
  expect(unusedDevices(list, 2).map((x) => x.device_id)).toEqual([1]);
});

it('says how long ago a device was used', () => {
  expect(lastActive(d(1, { active_now: true }), now)).toBe('Open now');
  expect(lastActive(d(1, { last_seen_at: ago(5 * MIN) }), now)).toBe('Active 5 minutes ago');
  expect(lastActive(d(1, { last_seen_at: ago(60 * MIN) }), now)).toBe('Active 1 hour ago');
  expect(lastActive(d(1, { last_seen_at: ago(DAY) }), now)).toBe('Active yesterday');
  expect(lastActive(d(1, { last_seen_at: ago(3 * DAY) }), now)).toBe('Active 3 days ago');
  expect(lastActive(d(1, { last_seen_at: ago(40 * DAY) }), now)).toMatch(/^Last active /);
  expect(lastActive(d(1, { last_seen_at: null }), now)).toBe('Not used yet');
});
