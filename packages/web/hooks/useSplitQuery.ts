import { useState } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { queryWithSignal } from "../lib/queryWithSignal";
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
type SplitRow = { id: string; hash: string; row: unknown };
type Held = {
  cache: SplitCache<any>;
  /** Settles once the rows saved by an earlier launch are in the cache. */
  restored: Promise<void>;
  /** The row object last handed to storage, per id. */
  saved: Map<string, unknown>;
  saveTimer: ReturnType<typeof setTimeout> | null;
};

/** Where held rows outlive the process. The native app sets one (its SQLite
 *  cache), so a relaunch rebuilds its first split result from disk instead of
 *  downloading the whole inbox and hashing every row again. */
export type SplitPersistence = {
  load(name: string): Promise<SplitRow[]>;
  save(name: string, upserts: SplitRow[], removes: string[]): void;
};
let persistence: SplitPersistence | null = null;
export function setSplitPersistence(p: SplitPersistence | null): void {
  persistence = p;
}

// Hot rows change with every push, so writes are batched.
const SAVE_EVERY_MS = 30_000;

const held = new Map<string, Held>();
function heldFor(name: string): Held {
  let h = held.get(name);
  if (h) return h;
  const cache: SplitCache<any> = new Map();
  const saved = new Map<string, unknown>();
  const restored = (persistence?.load(name) ?? Promise.resolve([])).then((rows) => {
    for (const { id, hash, row } of rows) {
      saved.set(id, row);
      if (!cache.has(id)) cache.set(id, { row, hash });
    }
  }, () => {});
  held.set(name, (h = { cache, restored, saved, saveTimer: null }));
  return h;
}
function cacheFor(name: string): SplitCache<any> {
  return heldFor(name).cache;
}

/** Queue a write of what the cache gained or lost since the last one. */
function noteHeldChanged(name: string): void {
  const h = heldFor(name);
  if (!persistence || h.saveTimer) return;
  h.saveTimer = setTimeout(() => {
    h.saveTimer = null;
    const upserts: SplitRow[] = [];
    const removes: string[] = [];
    for (const [id, { row, hash }] of h.cache) {
      if (h.saved.get(id) === row) continue;
      upserts.push({ id, hash, row });
      h.saved.set(id, row);
    }
    for (const id of h.saved.keys()) if (!h.cache.has(id)) removes.push(id);
    for (const id of removes) h.saved.delete(id);
    if (upserts.length || removes.length) persistence?.save(name, upserts, removes);
  }, SAVE_EVERY_MS);
}

/** Rebuild from the cache, and once more after the saved rows are restored. */
async function rebuildHeld(kind: SplitKind, value: any, name: string): Promise<any | null> {
  const h = heldFor(name);
  const rebuilt = rebuildSplitPayload(kind, value, h.cache);
  if (rebuilt || !value?.split) return rebuilt;
  await h.restored;
  return rebuildSplitPayload(kind, value, h.cache);
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

/**
 * A one-shot read of a split-capable query's whole result (the recovery
 * polls). It asks for the split form and rebuilds it from the subscription's
 * cache, so a quiet inbox's poll moves the recent rows, not the whole list;
 * the whole result travels only when the cache cannot vouch for a cold row.
 * `_probe` keeps each read a fresh round trip, never the live cache.
 */
export async function querySplitWhole(
  convex: Pick<ConvexReactClient, "watchQuery">,
  query: FunctionReference<"query">,
  args: Record<string, any>,
  kind: SplitKind,
  signal: AbortSignal,
): Promise<any> {
  const name = getFunctionName(query);
  const whole = () => queryWithSignal(convex, query, { ...args, _probe: Date.now() } as any, signal);
  if (unsupported.has(name)) return whole();
  const rebuilt = await rebuildHeld(kind, await queryWithSignal(convex, query, { ...args, split: true, _probe: Date.now() } as any, signal), name);
  noteHeldChanged(name);
  if (rebuilt) return rebuilt;
  const value = await whole();
  seedSplitCache(kind, value, cacheFor(name));
  return value;
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
      noteHeldChanged(name);
      return;
    }
    // The cache cannot vouch for the cold rows (first load, or one changed):
    // try again with the rows saved by the last launch, else fetch the whole
    // result once. A newer push cancels this one.
    let cancelled = false;
    void (async () => {
      const restored = await rebuildHeld(kind, value, name);
      if (cancelled) return;
      noteHeldChanged(name);
      if (restored) {
        setData(restored);
        return;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        let whole: any;
        try {
          whole = await convex.query(query, { ...args, _probe: Date.now() } as any);
        } catch {
          return; // the subscription's next push retries
        }
        if (cancelled) return;
        seedSplitCache(kind, whole, cache);
        noteHeldChanged(name);
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
