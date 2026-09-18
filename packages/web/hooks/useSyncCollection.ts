// THE generic feeder: one live query → one store collection.
//
// Local-first is the law (CLAUDE.md): a surface renders from the store
// synchronously and a live query only FEEDS it. Almost every feeder is the
// same six lines — subscribe, hand each push to syncTable, report readiness —
// so this hook is that shape once, and a new collection needs no hook file of
// its own. Bespoke feeders (a payload that fans out into several tables, a
// cursor to seed, a migration to run) still write their own; this covers the
// common case.
//
// useQueryNoThrow, never useQuery: a feeder mounts inside surfaces that must
// survive its query failing (a client ahead of a deploy, a saturated backend).
// The store keeps its cached rows; the caller gets `error` if it wants to say
// so.
//
// Every feeder here reads authenticated, workspace-scoped data, and the tree
// it mounts in is released on the LOCAL auth signal (offline-safe boot), so
// without a gate a feeder fires its query before the websocket has an
// authenticated identity and the handler's requireUser throws. The gate lives
// here, once, rather than as an `isAuthenticated ? args : "skip"` term in each
// of the ~50 call sites: useServerAuthSettled holds args at "skip" until the
// server has confirmed the caller. A surface that must read for an ANONYMOUS
// visitor (a share link resolving its own token, the community rooms) is not a
// feeder in this sense — it calls useQueryNoThrow itself, as the guest
// conversation path does.
import { useCallback, useRef } from "react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { getFunctionName } from "convex/server";
import { captureError } from "@/lib/analytics";
import { useInboxStore } from "../store/inboxStore";
import type { SyncOpts } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

/**
 * A feeder's terminal error is a fact worth recording even though the surface
 * keeps painting from the cache: the backend's 1s user-code cap on a saturated
 * host, or a client ahead of a deploy, would otherwise fail silently. Reported
 * once per distinct message per feeder — the subscription re-runs on the next
 * data change and the recovery poll re-probes on its own, so the same failure
 * can repeat every few seconds while the host is busy.
 */
export function useFeederError(feeder: string, error: Error | undefined): void {
  const lastRef = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!error) { lastRef.current = null; return; }
    if (lastRef.current === error.message) return;
    lastRef.current = error.message;
    console.warn(`[feeder:${feeder}] query failed; serving the cached rows`, error);
    captureError(error, { feeder });
  }, [feeder, error]);
}

export type SyncCollectionOpts<T = any> = {
  /** Pull the rows out of a wrapped payload (`{ artifacts: [...] }`) or reshape
   *  rows that lack `_id` (key them here — syncTable keys by `_id`). */
  select?: (data: T) => any;
  /** Per-call SyncOpts, merged over the registry defaults for this key. */
  syncOpts?: SyncOpts;
  /** Batch a hot subscription's pushes into one trailing apply. */
  coalesceMs?: number;
  /** Circuit-break a subscription that never resolves (see useQueryNoThrow). */
  breakAfterMs?: number;
};

export type SyncCollectionResult = {
  /** The first answer has landed. `false` with a populated store is the
   *  ordinary "painting from cache" state, not a loading state. */
  ready: boolean;
  error?: Error;
  /** The server answered `null`: it refused the caller (no access, a team
   *  the viewer left). Not an empty result, and nothing was synced. */
  refused: boolean;
  /** Subscribe again after a terminal error (useQueryNoThrow's own retry). */
  retry: () => void;
};

export function useSyncCollection<Query extends FunctionReference<"query">>(
  key: string,
  query: Query,
  args: FunctionArgs<Query> | "skip",
  opts?: SyncCollectionOpts,
): SyncCollectionResult {
  // Held at "skip" until the server has confirmed the caller — see the header.
  // "skip" is the same mechanism a caller uses for a scope it does not have
  // yet, so nothing downstream needs to know why this one is waiting.
  const authSettled = useServerAuthSettled();
  const gatedArgs = authSettled ? args : "skip";
  const { data, error, retry } = useQueryNoThrow(query, gatedArgs, opts?.breakAfterMs ? { breakAfterMs: opts.breakAfterMs } : undefined);
  useFeederError(getFunctionName(query), error);
  const syncTable = useInboxStore((s) => s.syncTable);
  const select = opts?.select;
  const syncOpts = opts?.syncOpts;
  useConvexSync(
    data,
    useCallback(
      (payload: any) => {
        const rows = select ? select(payload) : payload;
        if (rows === undefined || rows === null) return;
        syncTable(key, rows, syncOpts);
      },
      [key, select, syncOpts, syncTable],
    ),
    opts?.coalesceMs ? { coalesceMs: opts.coalesceMs } : undefined,
  );
  return { ready: data !== undefined, error, refused: data === null, retry };
}

/**
 * Rows without a server `_id` (artifacts keyed by slug, devices by device_id):
 * stamp one so the collection machinery keys them. Use inside `select`.
 */
export function keyRowsBy<T extends Record<string, any>>(rows: T[] | undefined | null, field: keyof T): Array<T & { _id: string }> {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ ...r, _id: String(r[field]) }));
}
