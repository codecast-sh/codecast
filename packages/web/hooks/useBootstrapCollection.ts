// The bootstrap floor for a log-covered collection (sync-log-cargo E8).
//
// Before cargo, each collection kept a LIVE list subscription open (webList &
// co.) as its freshness path — and Convex re-pushes a subscription's whole
// result on any change, so every task edit re-shipped the window to every open
// client. Steady-state freshness now rides the sync log (patches applied
// directly), so the list query's only remaining job is the snapshot floor: run
// ONCE per (collection, args) per page session — cold cache, workspace switch —
// as a one-shot query that registers no subscription, overlay it as a delta,
// and let the log carry everything after. The 24h safety-net crawl and the
// per-view queries are untouched.
//
// Host-only: a follower window's store is fed by the host's replication
// (docs/architecture/sync-host.md), so it neither subscribes nor bootstraps.
import { useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { useInboxStore } from "../store/inboxStore";
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

// One bootstrap per (key, args) per page session, shared across mounts.
const done = new Map<string, Promise<any[]>>();

export function bootstrapKey(key: string, args: unknown): string {
  return `${key}:${JSON.stringify(args)}`;
}

/** Test/HMR escape hatch. */
export function __resetBootstrapsForTests(): void {
  done.clear();
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
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const argsKey = args === "skip" ? "skip" : bootstrapKey(key, args);

  // eslint-disable-next-line no-restricted-syntax -- one-shot bootstrap per args
  useEffect(() => {
    if (args === "skip" || !isSyncHost || !hydrated) return;
    const scope = optsRef.current.liveLoadingScope;
    let cancelled = false;
    let p = done.get(argsKey);
    if (!p) {
      p = (async () => {
        const data = await convex.query(query, args);
        const rows = optsRef.current.select ? optsRef.current.select(data) : data;
        return Array.isArray(rows) ? rows : [];
      })();
      done.set(argsKey, p);
      p.catch(() => done.delete(argsKey)); // a failed floor retries on the next mount
    }
    if (scope) useInboxStore.getState().setLiveLoading(scope, true);
    p.then((rows) => {
      if (cancelled) return;
      const store = useInboxStore.getState();
      if (rows.length) store.syncTable(key, rows as any, { isDelta: true, ...optsRef.current.syncOpts } as any);
      optsRef.current.onRows?.(rows);
      setReady(true);
    }).catch((e) => console.warn(`[bootstrap] ${key} floor failed`, e))
      .finally(() => { if (scope && !cancelled) useInboxStore.getState().setLiveLoading(scope, false); });
    return () => {
      cancelled = true;
      if (scope) useInboxStore.getState().setLiveLoading(scope, false);
    };
  }, [argsKey, isSyncHost, hydrated, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { done.delete(argsKey); setNonce((n) => n + 1); };
  return { ready, refresh };
}
