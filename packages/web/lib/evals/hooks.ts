// The hooks every Evals page reads through: connect once, read a cached
// answer, and follow live work. The data never leaves memory (store/evalsStore.ts).

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import type { ChangesResponse, EvalsRouteKey, EvalsResponse } from "@codecast/shared/contracts/evalsApi";
import { useEvalsStore, evalsCacheKey } from "../../store/evalsStore";
import { useTabVisible } from "../../hooks/usePagePresence";
import type { EvalsArgs } from "./client";

/** Connects on first mount and hands back what the shell branches on. */
export function useEvalsConnection() {
  const convex = useConvex();
  const connection = useEvalsStore((s) => s.connection);
  const connect = useEvalsStore((s) => s.connect);
  useEffect(() => {
    if (useEvalsStore.getState().connection === "idle") void connect(convex);
  }, [connect, convex]);
  const retry = useCallback(() => void connect(convex, { force: true }), [connect, convex]);
  return { connection, retry };
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
export function useEvalsResource<K extends EvalsRouteKey>(key: K, args: EvalsArgs<K> | null): EvalsResourceView<EvalsResponse<K>> {
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

function subscribeVisibility(fn: () => void): () => void {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}
const documentVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

/** Every 3 s while `live` and this pane is on screen: polling pauses when the tab or window is hidden. */
export const EVALS_POLL_MS = 3_000;
/** A job with no new step for this long shows "stalled?". */
export const EVALS_STALL_MS = 5 * 60_000;

/**
 * Follows `GET /changes` while a view shows live work (a landing batch, a
 * bisect, a shrink or a sweep), handing each answer with anything new to
 * `onChanges`. The cursor lives here, so each view follows from when it opened.
 */
export function useEvalsChanges(live: boolean, onChanges: (changes: ChangesResponse) => void) {
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
  const paneVisible = useTabVisible();
  const connected = useEvalsStore((s) => s.connection === "connected");
  const cursor = useRef<number | null>(null);
  const handler = useRef(onChanges);
  handler.current = onChanges;
  const on = live && visible && paneVisible && connected;
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    const tick = async () => {
      try {
        const changes = await useEvalsStore.getState().call("GET /changes", { query: { since: cursor.current ?? 0 } });
        if (stopped) return;
        const first = cursor.current === null;
        cursor.current = changes.cursor;
        if (!first && (changes.runs.length || changes.bisects.length || changes.jobs.length)) handler.current(changes);
      } catch {
        // An area-wide failure already moved the connection; a one-off miss waits for the next tick.
      }
    };
    void tick();
    const id = setInterval(tick, EVALS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [on]);
}
