/**
 * Persist the daemon's Convex WebSocket up/down flag.
 *
 * ConvexClient.subscribeToConnectionState does not replay the current state
 * to a new subscriber. Subscribe first, then seed from connectionState() so
 * an already-open socket is recorded even when its connecting→ready microtask
 * already ran with no listeners.
 *
 * ConnectionState also changes on inflight-request counts; callers should
 * treat this helper as the only writer of the boolean so those extra events
 * do not churn daemon.state.
 */

export type ConvexSocketClient = {
  connectionState: () => { isWebSocketConnected: boolean };
  subscribeToConnectionState: (
    cb: (cs: { isWebSocketConnected: boolean }) => void,
  ) => unknown;
};

export function bindConvexConnectionState(
  client: ConvexSocketClient,
  opts: {
    saveConnected: (connected: boolean) => void;
    onRestored?: () => void;
    onChange?: (connected: boolean) => void;
  },
): () => void {
  let last: boolean | undefined;
  const publish = (cs: { isWebSocketConnected: boolean }) => {
    if (cs.isWebSocketConnected === last) return;
    const restored = last === false && cs.isWebSocketConnected;
    last = cs.isWebSocketConnected;
    opts.saveConnected(cs.isWebSocketConnected);
    opts.onChange?.(cs.isWebSocketConnected);
    if (restored) opts.onRestored?.();
  };
  const unsub = client.subscribeToConnectionState(publish);
  publish(client.connectionState());
  return typeof unsub === "function" ? (unsub as () => void) : () => {};
}
