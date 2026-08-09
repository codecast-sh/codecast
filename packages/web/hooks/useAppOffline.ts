import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";

// How long the WebSocket must stay down before we call it "disconnected".
// Covers the normal boot handshake and transient reconnects so consumers
// never flash on a healthy load. navigator.onLine === false is definitive
// and skips the grace period.
const DISCONNECT_GRACE_MS = 5_000;

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
  const [wsDownLong, setWsDownLong] = useState(false);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (!wsDown) {
      setWsDownLong(false);
      return;
    }
    const t = setTimeout(() => setWsDownLong(true), DISCONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, [wsDown]);

  return { offline: !online || (wsDown && wsDownLong), online };
}
