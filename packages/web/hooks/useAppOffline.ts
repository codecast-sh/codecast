import { useCallback, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { WEBSOCKET_HANDSHAKE_TIMEOUT_MS } from "@codecast/shared/network";

import { useMountEffect } from "./useMountEffect";
import { useWatchEffect } from "./useWatchEffect";
// Outlast the recovering socket's handshake, plus the close-and-retry after
// a stalled CONNECTING. navigator.onLine flips false for a moment on every
// network change, so it is a hint, not a verdict — same grace.
export const DISCONNECT_GRACE_MS = WEBSOCKET_HANDSHAKE_TIMEOUT_MS + 5_000;
// The OS flag can also be wrong for the life of the process: Chromium reads
// the interface list at startup and again only when reachability flips, so an
// app launched while a link renegotiates (2026-09-21: the desktop app
// relaunched two seconds before en0 had an address) reports no network until
// it is relaunched. The socket is the verdict. The Convex client drops a
// socket after 60s of server silence (WebSocketManager.serverInactivityThreshold),
// so a socket still up that long after the OS said offline proves the flag stale.
const CONVEX_SERVER_INACTIVITY_MS = 60_000;
export const STALE_OS_OFFLINE_MS = CONVEX_SERVER_INACTIVITY_MS + 15_000;

export type AppOffline = { offline: boolean; online: boolean };

export type ConnectionNotice = { title: string; detail: string };
export type ConnectionChipCopy = { label: string; detail: string };

/**
 * Bottom-left card copy. A dropped Convex socket is not an outage the user
 * needs a card for: the app is already serving from the local cache, and the
 * header LED carries the reconnecting state. The card is only for a true OS
 * offline, after the grace period.
 */
export function connectionNotice({ offline, online }: AppOffline): ConnectionNotice | null {
  if (!offline || online) return null;
  return {
    title: "Offline",
    detail: "showing locally cached data; changes will sync when the connection returns.",
  };
}

/** Header LED copy while we cannot sync. Null when the socket is up. */
export function connectionChipCopy({ offline, online }: AppOffline): ConnectionChipCopy | null {
  if (!offline) return null;
  return online
    ? {
        label: "Reconnecting",
        detail: "The live server link dropped. This view is from the cache, and it will sync when the link returns.",
      }
    : {
        label: "Offline",
        detail: "This device has no network. This view is from the cache, and it will sync when the connection returns.",
      };
}

/**
 * Is this client running from local cache right now? True when the OS
 * reports no network, or the Convex WebSocket has been down past the grace
 * period. An OS flag that stays offline while the socket outlives the server
 * inactivity threshold is stale and stops counting. Drives the ConnectionBanner (OS-offline card only) and the header
 * LED, and suppresses banners that would misattribute our own lost
 * connection to something else (e.g. the CLI daemon looking stale merely
 * because nothing can sync).
 */
export function useAppOffline(): AppOffline {
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

  const [osOnline, setOsOnline] = useState(() => navigator.onLine);
  const [osFlagStale, setOsFlagStale] = useState(false);
  const [downLong, setDownLong] = useState(false);

  useMountEffect(() => {
    const sync = () => setOsOnline(navigator.onLine);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  });

  useWatchEffect(() => {
    if (osOnline) {
      setOsFlagStale(false);
      return;
    }
    if (wsDown) return;
    const t = setTimeout(() => {
      console.warn(`[useAppOffline] navigator.onLine has said offline for ${STALE_OS_OFFLINE_MS}ms while the Convex socket stayed up; treating the OS flag as stale`);
      setOsFlagStale(true);
    }, STALE_OS_OFFLINE_MS);
    return () => clearTimeout(t);
  }, [osOnline, wsDown]);

  const online = osOnline || osFlagStale;
  const down = wsDown || !online;
  useWatchEffect(() => {
    if (!down) {
      setDownLong(false);
      return;
    }
    const t = setTimeout(() => setDownLong(true), DISCONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, [down]);

  return { offline: down && downLong, online };
}
