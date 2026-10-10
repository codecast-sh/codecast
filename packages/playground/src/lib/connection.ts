// Whether the shell reaches Clayground right now. The connection state is said
// in the chrome the person is already looking at (the room header, the
// capsule, a waiting button), never floated over the app.
import { useEffect, useState, useSyncExternalStore } from "react";
import { convex } from "./convex";

/** A drop shorter than this is a blip, not news. */
export const DOWN_AFTER_MS = 500;
/** A button still waiting on the server this long into a drop says so. */
export const WAITING_AFTER_MS = 8_000;

/** A reconnect counts once it has held this long; a flapping connection
 *  that drops again sooner is still the same outage. */
const STABLE_MS = 1_500;

/** When the connection dropped, after it was up once; null while it is up. */
let lostAt: number | null = null;
let settle: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const set = (next: number | null) => {
  if (next === lostAt) return;
  lostAt = next;
  for (const l of listeners) l();
};
convex.subscribeToConnectionState((st) => {
  const lost = st.hasEverConnected && !st.isWebSocketConnected;
  if (lost) {
    clearTimeout(settle);
    settle = undefined;
    set(lostAt ?? Date.now());
  } else if (lostAt !== null && settle === undefined) {
    settle = setTimeout(() => {
      settle = undefined;
      set(null);
    }, STABLE_MS);
  }
});
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True once the connection has been down for `ms`. */
export function useOffline(ms = DOWN_AFTER_MS): boolean {
  const at = useSyncExternalStore(subscribe, () => lostAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const left = at + ms - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [at, ms]);
  return at !== null && Date.now() - at >= ms;
}
