// The bootstrap floor for a log-covered collection (sync-log-cargo E8).
//
// Before cargo, each collection kept a LIVE list subscription open (webList &
// co.) as its freshness path — and Convex re-pushes a subscription's whole
// result on any change, so every task edit re-shipped the window to every open
// client. Steady-state freshness now rides the sync log (patches applied
// directly), so the list query's only remaining job is the snapshot floor: run
// ONCE per (collection, args) per floor epoch — cold cache, workspace switch,
// resync, scope rejoin — as a one-shot query that registers no subscription,
// overlay it as a delta, and let the log carry everything after. The 24h
// safety-net crawl and the per-view queries are untouched.
//
// Host-only: a follower window's store is fed by the host's replication
// (docs/architecture/sync-host.md), so it neither subscribes nor bootstraps.
import { useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { useInboxStore } from "../store/inboxStore";
import { mapSlots } from "../store/simSlot";
import { useIsSyncHost } from "./useSyncRole";

type Opts = {
  /** Rows out of the payload (`{ items }`, `{ page }`, …). */
  select?: (data: any) => any[] | undefined | null;
  /** The header pill's scope name; set while the first floor is in flight. */
  liveLoadingScope?: string;
  /** Overlay hook (badge fetches, prefetches) — called with the rows. */
  onRows?: (rows: any[]) => void;
  syncOpts?: Record<string, any>;
};

// One bootstrap per floor key, shared across mounts. The rows are applied to
// the store exactly once (`applied`): a remount after the floor landed must not
// re-overlay a stale snapshot over log patches that arrived in between.
type Floor = { promise: Promise<any[]>; applied: boolean };
const done = new Map<string, Floor>();

export function bootstrapKey(key: string, args: unknown): string {
  return `${key}:${JSON.stringify(args)}`;
}

// The sync-log scopes a workspace floor's rows fan out from (E8 / D9). A team
// list also returns rows the viewer holds through their own scope (assigned
// tasks, private-in-team rows), so a team floor waits on BOTH the user and the
// team scope; a personal floor on the user scope. Null: not resolvable yet.
export function floorScopeKeys(
  args: { workspace?: string; team_id?: unknown } | "skip",
  principal: string | null,
): string[] | null {
  if (args === "skip" || !principal) return null;
  const keys = [`user:${principal}`];
  if (args.workspace === "team" && args.team_id) keys.push(`team:${String(args.team_id)}`);
  return keys;
}

/** Test/HMR escape hatch. */
export function resetBootstrapFloors(): void {
  done.clear();
}

/**
 * Sim seam: the floors belong to one window. get() snapshots them (the map is
 * copied, so the snapshot is detached), set() loads a snapshot back, fresh()
 * is what a window that never ran starts from.
 */
export function __bootstrapSimSlots() {
  return mapSlots({ done });
}

// Entries from an earlier epoch or principal can never be asked for again;
// drop them so the map stays the size of one page session's live floors.
function forgetFloorsOutside(prefix: string): void {
  for (const k of done.keys()) if (!k.startsWith(prefix)) done.delete(k);
}

// Fetch a floor once per key and apply its rows once, however many mounts
// await it. A failed fetch forgets the key so the next mount retries. `live`
// fences the apply: a floor whose epoch or principal moved while its query was
// in flight (resync, sign-out) resolves into a store it must not touch.
export function loadFloorOnce(
  argsKey: string,
  fetch: () => Promise<any>,
  apply: (rows: any[]) => void,
  live: () => boolean = () => true,
): Promise<any[]> {
  let floor = done.get(argsKey);
  if (!floor) {
    const promise = fetch().then((rows) => (Array.isArray(rows) ? rows : []));
    floor = { promise, applied: false };
    done.set(argsKey, floor);
    promise.catch(() => { if (done.get(argsKey) === floor) done.delete(argsKey); });
  }
  const f = floor;
  return f.promise.then((rows) => {
    if (!f.applied) {
      f.applied = true;
      if (live()) apply(rows);
    }
    return rows;
  });
}

function principalOf(s: any): string | null {
  const id = s.currentUser?._id;
  return id ? String(id) : null;
}

// Keyed by principal and epoch (review): account A's floor must not stand in
// for account B's, and a resync or rejoin must recut every mounted floor.
const floorPrefix = (principal: string | null, epoch: number) => `${principal}:${epoch}:`;
export function bootstrapFloorKey(principal: string | null, epoch: number, key: string, args: unknown): string {
  return `${floorPrefix(principal, epoch)}${bootstrapKey(key, args)}`;
}

/** Every scope the floor's rows fan out from has a stamped cursor (false while unresolved). */
export function floorScopesStamped(s: any, scopes: string[] | null): boolean {
  return !!scopes && scopes.every((k) => s.syncLogScopeStamps[k] !== undefined);
}

export type BootstrapFloorRun = {
  convex: { query: (query: any, args: any) => Promise<any> };
  key: string;
  query: any;
  args: Record<string, any>;
  principal: string | null;
  epoch: number;
  /** Read at each step, so a caller can swap options while the floor runs. */
  opts: () => Opts;
  onReady?: () => void;
};

/**
 * Cut one bootstrap floor (its gates already open): fetch once per key,
 * overlay the rows as a delta, fenced on the epoch and principal it was cut
 * at. Returns the cancel. The hook runs this from its effect; the multiplayer
 * simulator runs it from a window's turn.
 */
export function startBootstrapFloor(run: BootstrapFloorRun): () => void {
  const { convex, key, query, args, principal, epoch, opts } = run;
  const scope = opts().liveLoadingScope;
  let cancelled = false;
  if (scope) useInboxStore.getState().setLiveLoading(scope, true);
  forgetFloorsOutside(floorPrefix(principal, epoch));
  const live = () => {
    const s = useInboxStore.getState();
    return s.syncLogFloorEpoch === epoch && principalOf(s) === principal;
  };
  loadFloorOnce(
    bootstrapFloorKey(principal, epoch, key, args),
    async () => {
      const data = await convex.query(query, args);
      const select = opts().select;
      return select ? select(data) : data;
    },
    (rows) => {
      if (rows.length) useInboxStore.getState().syncTable(key, rows as any, { isDelta: true, ...opts().syncOpts } as any);
    },
    live,
  ).then((rows) => {
    if (cancelled || !live()) return;
    opts().onRows?.(rows);
    run.onReady?.();
  }).catch((e) => console.warn(`[bootstrap] ${key} floor failed`, e))
    .finally(() => { if (scope && !cancelled) useInboxStore.getState().setLiveLoading(scope, false); });
  return () => {
    cancelled = true;
    if (scope) useInboxStore.getState().setLiveLoading(scope, false);
  };
}

/**
 * The floor a window cuts from one read of its state, or null while a gate is
 * closed (not hydrated, or a scope not yet stamped). Host-only is the
 * caller's gate. The hook reads the same inputs through subscriptions.
 */
export function bootstrapFloorFor(
  s: any,
  convex: BootstrapFloorRun["convex"],
  key: string,
  query: any,
  args: Record<string, any> | "skip",
  opts: Opts = {},
): BootstrapFloorRun | null {
  const principal = principalOf(s);
  if (args === "skip" || !s.clientStateInitialized || !floorScopesStamped(s, floorScopeKeys(args, principal))) return null;
  return { convex, key, query, args, principal, epoch: s.syncLogFloorEpoch, opts: () => opts };
}

export function useBootstrapCollection(
  key: string,
  query: any,
  args: Record<string, any> | "skip",
  opts: Opts = {},
): { ready: boolean; refresh: () => void } {
  const convex = useConvex();
  const isSyncHost = useIsSyncHost();
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const principal = useInboxStore(principalOf);
  const epoch = useInboxStore((s) => s.syncLogFloorEpoch);
  // The applier stamps a scope's cursor before a floor on it may be cut (E8 /
  // D9): a floor queried before the stamp can miss writes that commit between
  // its query and the heads capture. Per scope: the scopes this floor's rows
  // fan out from, not "some scope was stamped once".
  const scopes = floorScopeKeys(args, principal);
  const stamped = useInboxStore((s) => floorScopesStamped(s, scopes));
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const argsKey = args === "skip" ? "skip" : bootstrapFloorKey(principal, epoch, key, args);

  // eslint-disable-next-line no-restricted-syntax -- one-shot bootstrap per args
  useEffect(() => {
    if (args === "skip" || !isSyncHost || !hydrated || !stamped) return;
    return startBootstrapFloor({ convex, key, query, args, principal, epoch, opts: () => optsRef.current, onReady: () => setReady(true) });
  }, [argsKey, isSyncHost, hydrated, stamped, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { done.delete(argsKey); setNonce((n) => n + 1); };
  return { ready, refresh };
}
