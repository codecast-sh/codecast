import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";

// How long the connection must stay down before we call it "disconnected".
// Covers the normal boot handshake, a reconnect after a laptop wake, and the
// few seconds a Wi-Fi handoff or VPN toggle drops the OS's online flag —
// all of which resolve on their own and must not flash a banner. The same
// grace applies to navigator.onLine: the browser flips it false for a moment
// on every network change, so it is a hint, not a verdict.
const DISCONNECT_GRACE_MS = 8_000;

/**
 * Is this client running from local cache right now? True when the OS
 * reports no network, or the Convex WebSocket has been down past the grace
 * period. Drives the ConnectionBanner and suppresses banners that would
 * misattribute our own lost connection to something else (e.g. the CLI
 * daemon looking stale merely because nothing can sync).
 */
export function useAppOffline(): { offline: boolean; online: boolean } {
  // Subscribe to ONLY the websocket-connected boolean, not the whole connection
  // state: `useConvexConnectionState()` re-emits on every in-flight request
  // (each keystroke's draft mutation, every query of a session switch), which
  // re-rendered every consumer of this hook — three always-mounted banners/chips
  // — on essentially all network activity. The boolean snapshot lets
  // useSyncExternalStore bail unless connectivity actually flips.
  const convex = useConvex();
  const wsConnected = useSyncExternalStore(
    useCallback((cb: () => void) => convex.subscribeToConnectionState(cb), [convex]),
    () => convex.connectionState().isWebSocketConnected,
  );
  const wsDown = !wsConnected;

  const [online, setOnline] = useState(() => navigator.onLine);
  const [downLong, setDownLong] = useState(false);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const down = wsDown || !online;
  useEffect(() => {
    if (!down) {
      setDownLong(false);
      return;
    }
    const t = setTimeout(() => setDownLong(true), DISCONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, [down]);

  return { offline: down && downLong, online };
}
