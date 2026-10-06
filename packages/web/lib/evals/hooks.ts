// The hooks every Evals page reads through: connect once, read a cached
// answer, and follow live work. The data never leaves memory (store/evalsStore.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type { ChangesResponse, EvalsRouteKey, EvalsResponse, EvalsRoutes, HealthResponse } from "@codecast/shared/contracts/evalsApi";
import { EVALS_POLL, followChanges, type CachedResource, type EvalsArgs, type Visibility } from "@platform/evals/client";
import { useEvalsStore, evalsCacheKey } from "../../store/evalsStore";
import { useTabVisible } from "../../hooks/usePagePresence";

/** How long the shell waits before each automatic retry of a daemon that was live but slow to answer; the last step repeats. */
export const EVALS_SLOW_RETRY_MS = [5_000, 15_000, 30_000] as const;

/**
 * Connects on first mount and hands back what the shell branches on. A
 * daemon that is registered as live but slow to answer is load, not a dead
 * end, so the connection is tried again on its own, backing off (5 s, 15 s,
 * then every 30 s); `retryAt` says when the next try is due. A retry keeps
 * every answer already read: a slow daemon does not make them wrong.
 */
export function useEvalsConnection() {
  const convex = useConvex();
  const connection = useEvalsStore((s) => s.connection);
  const reason = useEvalsStore((s) => s.unreachableReason);
  const connect = useEvalsStore((s) => s.connect);
  useEffect(() => {
    if (useEvalsStore.getState().connection === "idle") void connect(convex);
  }, [connect, convex]);
  const retry = useCallback(() => void connect(convex, { force: true }), [connect, convex]);

  const slow = connection === "no-daemon" && reason === "daemon-slow";
  const [attempt, setAttempt] = useState(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  useEffect(() => {
    if (connection === "connected") setAttempt(0);
    if (!slow) {
      setRetryAt(null);
      return;
    }
    const wait = EVALS_SLOW_RETRY_MS[Math.min(attempt, EVALS_SLOW_RETRY_MS.length - 1)];
    setRetryAt(Date.now() + wait);
    const t = setTimeout(() => {
      setAttempt((n) => n + 1);
      retry();
    }, wait);
    return () => clearTimeout(t);
  }, [slow, attempt, connection, retry]);
  return { connection, retry, retryAt };
}

export interface EvalsResourceView<T> {
  data: T | null;
  error: string | null;
  /** The HTTP status of the last failure (404 for an unknown id). */
  status: number | null;
  loading: boolean;
  reload: () => void;
}

/**
 * The answer to one route, loaded once the area is connected and cached in
 * memory by its request. `null` args skip the load (a page waiting on a pick).
 * A cached answer paints at once; `reload` refetches in the background.
 */
export function useEvalsResource<K extends EvalsRouteKey>(key: K, args: EvalsArgs<EvalsRoutes, K> | null): EvalsResourceView<EvalsResponse<K>> {
  const cacheKey = args ? evalsCacheKey(key, args) : null;
  const connected = useEvalsStore((s) => s.connection === "connected");
  const res = useEvalsStore((s) => (cacheKey ? s.resources[cacheKey] : undefined));
  const argsRef = useRef(args);
  argsRef.current = args;
  useEffect(() => {
    if (connected && cacheKey && argsRef.current) void useEvalsStore.getState().load(key, argsRef.current);
  }, [connected, cacheKey, key]);
  const reload = useCallback(() => {
    if (argsRef.current) void useEvalsStore.getState().load(key, argsRef.current, { force: true });
  }, [key]);
  return useMemo(
    () => ({ data: (res?.data as EvalsResponse<K> | null) ?? null, error: res?.error ?? null, status: res?.status ?? null, loading: !res || res.loading, reload }),
    [res, reload],
  );
}

/** How the area is doing: GET /health as last read, whether it is connected, and the transport's kind ("fixture" marks the dev world). */
export function useEvalsHealth(): { health: HealthResponse | null; connected: boolean; transport: string | null; refresh: () => void } {
  const health = useEvalsStore((s) => s.health);
  const connected = useEvalsStore((s) => s.connection === "connected");
  const transport = useEvalsStore((s) => s.transport?.kind ?? null);
  const refresh = useCallback(() => void useEvalsStore.getState().refreshHealth(), []);
  return useMemo(() => ({ health, connected, transport, refresh }), [health, connected, transport, refresh]);
}

/** Every answer the area holds, by cache key: what the search can resolve without asking. */
export function useEvalsLoaded(): Record<string, CachedResource> {
  return useEvalsStore((s) => s.resources);
}

/**
 * The area's verbs outside a render: `call` one route for its answer (a
 * start, a stop, a price), `load` an answer into the cache, and `invalidate`
 * the cached answers a write made stale.
 */
export function useEvalsClient() {
  return useMemo(() => {
    const { call, load, invalidate } = useEvalsStore.getState();
    return { call, load, invalidate };
  }, []);
}

export { useDebounce } from "../../hooks/useDebounce";

function subscribeVisibility(fn: () => void): () => void {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}
const documentVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

/** This pane as a poller reads it: on screen while the document is visible and the pane is shown, with a change heard from either. */
function usePaneVisibility(): Visibility {
  const paneVisible = useTabVisible();
  const pane = useRef(paneVisible);
  const [visibility] = useState(() => {
    const listeners = new Set<() => void>();
    return {
      notify: () => listeners.forEach((fn) => fn()),
      visible: () => documentVisible() && pane.current,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        const off = subscribeVisibility(fn);
        return () => {
          listeners.delete(fn);
          off();
        };
      },
    };
  });
  useEffect(() => {
    pane.current = paneVisible;
    visibility.notify();
  }, [paneVisible, visibility]);
  return visibility;
}

/**
 * Follows `GET /changes` while a view shows live work (a landing batch, a
 * bisect, a shrink or a sweep), handing each answer with anything new to
 * `onChanges`. Polling pauses while the tab, the window or the pane is hidden
 * and asks at once on return; the cursor lives in the follower, so each view
 * follows from when it went live.
 */
export function useEvalsChanges(live: boolean, onChanges: (changes: ChangesResponse) => void) {
  const visibility = usePaneVisibility();
  const connected = useEvalsStore((s) => s.connection === "connected");
  const handler = useRef(onChanges);
  handler.current = onChanges;
  useEffect(() => {
    if (!live || !connected) return;
    // An area-wide failure already moved the connection; a one-off miss waits for the next tick.
    return followChanges((since) => useEvalsStore.getState().call("GET /changes", { query: { since } }), (changes) => handler.current(changes), EVALS_POLL, visibility);
  }, [live, connected, visibility]);
}
