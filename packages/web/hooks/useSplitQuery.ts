import { useState } from "react";
import { useConvex } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { cacheRows, rebuildRows, type SplitCache } from "@codecast/shared/contracts/inboxSplit";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

// The live inbox queries in their split wire form (shared/contracts/inboxSplit):
// the subscription carries the recent rows and a hash over the rest, and this
// feeder rebuilds the whole result before any applier sees it. The store, the
// appliers and the convergence contract therefore see exactly the payload the
// unsplit query returns; only the bytes on the wire change.

export type SplitKind = "list" | "liveness";

// Per query: the rows earlier results carried. Transport state, like Convex's
// own result cache, never read by a surface. A stale or foreign row cannot leak
// through: every rebuild is checked against the server's hash.
const caches = new Map<string, SplitCache<any>>();
function cacheFor(name: string): SplitCache<any> {
  let c = caches.get(name);
  if (!c) caches.set(name, (c = new Map()));
  return c;
}

// A server that predates the split argument rejects it; the feeder then
// subscribes to the whole result for the rest of the page, as before.
const unsupported = new Set<string>();
const rejectsSplit = (e: unknown) => /split/.test(String((e as any)?.message ?? e)) && /ArgumentValidationError|extra field/i.test(String((e as any)?.message ?? e));

/** The whole result a split value stands for, or null when the cache cannot vouch for its cold rows. Unsplit values pass through. Pure; unit-tested. */
export function rebuildSplitPayload(kind: SplitKind, value: any, cache: SplitCache<any>): any | null {
  if (!value?.split) return value;
  if (kind === "list") {
    const rows = rebuildRows({ ids: value.ids, hot: value.hot.map((r: any) => [String(r._id), r]), cold_hash: value.cold_hash }, cache);
    return rows && { sessions: rows.map(([, r]) => r), hidden_count: value.hidden_count, truncated: value.truncated };
  }
  const rows = rebuildRows({ ids: value.ids, hot: Object.entries(value.hot), cold_hash: value.cold_hash }, cache);
  return rows && { liveness: Object.fromEntries(rows), projection: value.projection };
}

/** Hold the rows of a whole (unsplit) result, so the next split value can be rebuilt from them. */
export function seedSplitCache(kind: SplitKind, whole: any, cache: SplitCache<any>): void {
  if (kind === "list") cacheRows(cache, (whole?.sessions ?? []).map((r: any) => [String(r._id), r]));
  else cacheRows(cache, Object.entries(whole?.liveness ?? {}));
}

/** useQueryNoThrow for a split-capable inbox query: returns the whole result, rebuilt. */
export function useSplitQueryNoThrow<Q extends FunctionReference<"query">>(
  query: Q,
  args: Record<string, any> | "skip",
  kind: SplitKind,
): { data: any; error: Error | undefined } {
  const name = getFunctionName(query);
  const convex = useConvex();
  const [, rerender] = useState(0);
  const splitOn = args !== "skip" && !unsupported.has(name);
  const sub = useQueryNoThrow(query, args === "skip" ? "skip" : splitOn ? ({ ...args, split: true } as any) : (args as any));
  const [data, setData] = useState<any>(undefined);

  useWatchEffect(() => {
    if (splitOn && sub.error && rejectsSplit(sub.error)) {
      unsupported.add(name);
      rerender((n) => n + 1);
    }
  }, [splitOn, sub.error, name]);

  useWatchEffect(() => {
    const value = sub.data;
    if (value === undefined || args === "skip") return;
    const cache = cacheFor(name);
    const rebuilt = rebuildSplitPayload(kind, value, cache);
    if (rebuilt) {
      setData(rebuilt);
      return;
    }
    // The cache cannot vouch for the cold rows (first load, or one changed):
    // fetch the whole result once. A newer push cancels this one.
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let whole: any;
        try {
          whole = await convex.query(query, { ...args, _probe: Date.now() } as any);
        } catch {
          return; // the subscription's next push retries
        }
        if (cancelled) return;
        seedSplitCache(kind, whole, cache);
        const again = rebuildSplitPayload(kind, value, cache);
        // The fetch read a different moment than the push (a cold row changed
        // in between): try once more, then take the fetch, a whole snapshot.
        if (again || attempt === 1) {
          setData(again ?? whole);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `args` is a constant per caller; its JSON is what the subscription keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.data, kind, name, convex]);

  return { data: args === "skip" ? undefined : splitOn ? data : sub.data, error: splitOn && sub.error && rejectsSplit(sub.error) ? undefined : sub.error };
}
