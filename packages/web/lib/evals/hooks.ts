// The hooks codecast's own Evals files read through: the shared views' hooks
// (@platform/evals/react, which read the nearest EvalsProvider) typed by
// codecast's wider route table, and the connection to the daemon, which is
// codecast's. The data never leaves memory (store/evalsStore.ts).

import { useCallback, useEffect, useState } from "react";
import { useConvex } from "convex/react";
import type { EvalsRoutes } from "@codecast/shared/contracts/evalsApi";
import { evalsHooks } from "@platform/evals/react";
import { useEvalsStore } from "../../store/evalsStore";

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

/** One route's cached answer, the client's verbs and the change feed, over codecast's routes (sim, search, run files, patches, bisect writes). */
export const { useEvalsResource, useEvalsClient, useEvalsChanges } = evalsHooks<EvalsRoutes>();
export { useDebounce, useEvalsHealth, useEvalsLoaded, type EvalsResourceView } from "@platform/evals/react";
