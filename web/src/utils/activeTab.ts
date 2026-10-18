// src/utils/activeTab.ts
// Only one tab per browser runs the chats (like WhatsApp Web). All tabs share one set of
// encryption keys and one message database, and two tabs updating them at the same time can
// leave messages unreadable. The active tab holds a Web Lock; other tabs show "open in another
// tab" with "Use here", which hands the lock over (the old tab reloads into that screen).

const LOCK = 'shareeven-active-tab';
const TAKE_OVER = 'take-over';

type State = 'checking' | 'active' | 'elsewhere';

let state: State = 'checking';
let release: (() => void) | null = null;
const listeners = new Set<(s: State) => void>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('shareeven-tabs') : null;

const setState = (next: State) => {
  state = next;
  listeners.forEach((l) => l(next));
};

/** Ask for the lock; `wait` queues behind the tab holding it instead of giving up. */
function claim(wait: boolean): Promise<boolean> {
  // No Web Locks (very old browser, or a plain-http address other than localhost): one tab as before
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks
      .request(LOCK, wait ? {} : { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise<void>((done) => { release = done; }); // held until this tab closes or hands over
      })
      .catch(() => resolve(true));
  });
}

// Once per page load (not in an effect: React's StrictMode would ask twice and lose to itself)
claim(false).then((ok) => setState(ok ? 'active' : 'elsewhere'));

// Another tab pressed "Use here": let go and reload, which lands on the "open elsewhere" screen
channel?.addEventListener('message', (e) => {
  if (e.data !== TAKE_OVER || !release) return;
  release();
  release = null;
  window.location.reload();
});

export const activeTabState = (): State => state;

export function onActiveTabChange(listener: (s: State) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Resolves once this tab is the active one (straight away if it already is). */
export function whenActiveTab(): Promise<void> {
  if (state === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const stop = onActiveTabChange((s) => { if (s === 'active') { stop(); resolve(); } });
  });
}

/** "Use here": take the chats over from the other tab. */
export async function takeOverTab(): Promise<void> {
  setState('checking');
  const waiting = claim(true); // queue first, so the lock comes here and not to a reloading tab
  channel?.postMessage(TAKE_OVER);
  await waiting;
  setState('active');
}
