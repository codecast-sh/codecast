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
import { useCallback } from "react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { useInboxStore } from "../store/inboxStore";
import type { SyncOpts } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";

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
};

export function useSyncCollection<Query extends FunctionReference<"query">>(
  key: string,
  query: Query,
  args: FunctionArgs<Query> | "skip",
  opts?: SyncCollectionOpts,
): SyncCollectionResult {
  const { data, error } = useQueryNoThrow(query, args, opts?.breakAfterMs ? { breakAfterMs: opts.breakAfterMs } : undefined);
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
  return { ready: data !== undefined, error };
}

/**
 * Rows without a server `_id` (artifacts keyed by slug, devices by device_id):
 * stamp one so the collection machinery keys them. Use inside `select`.
 */
export function keyRowsBy<T extends Record<string, any>>(rows: T[] | undefined | null, field: keyof T): Array<T & { _id: string }> {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ ...r, _id: String(r[field]) }));
}
