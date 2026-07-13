import { useEffect, useState } from "react";
import { useConvexConnectionState } from "convex/react";

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
  const connection = useConvexConnectionState();
  const wsDown = !connection.isWebSocketConnected;

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
