// Background work that would compete with the boot's first paints (the inbox
// and the open conversation) waits for the page's first idle period; after
// that, everything runs at once. The timeout matters: Chrome starves idle
// callbacks in hidden windows, and the desktop app often boots minimized.
// Where there is no requestIdleCallback (the Expo app, tests) nothing waits.
const BOOT_IDLE_TIMEOUT_MS = 2_000;

let settled = typeof window === "undefined" || typeof (window as any).requestIdleCallback !== "function";
const queued = new Set<() => void>();

function settle(): void {
  settled = true;
  const fns = [...queued];
  queued.clear();
  for (const fn of fns) fn();
}

if (!settled) (window as any).requestIdleCallback(settle, { timeout: BOOT_IDLE_TIMEOUT_MS });

/** Run `fn` once the booting page has first gone idle; at once after that. Returns a cancel. */
export function afterBootIdle(fn: () => void): () => void {
  if (settled) {
    fn();
    return () => {};
  }
  queued.add(fn);
  return () => { queued.delete(fn); };
}
