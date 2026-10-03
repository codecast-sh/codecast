import { useCallback, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";

/**
 * Is the Convex WebSocket connected right now?
 *
 * Subscribes to ONLY that boolean, not the whole connection state:
 * `useConvexConnectionState()` re-emits on every in-flight request (each
 * keystroke's draft mutation, every query of a session switch), which
 * re-renders every consumer on essentially all network activity. The boolean
 * snapshot lets useSyncExternalStore bail unless connectivity actually flips.
 *
 * Store free: the guest's meeting page reads it too (a Convex query never
 * errors when the socket is down, it only stops answering, so this is the one
 * honest signal that the page has lost touch with the server).
 */
export function useWsConnected(): boolean {
  const convex = useConvex();
  return useSyncExternalStore(
    useCallback((cb: () => void) => convex.subscribeToConnectionState(cb), [convex]),
    () => convex.connectionState().isWebSocketConnected,
    () => true,
  );
}
