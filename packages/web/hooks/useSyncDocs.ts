import { useCallback, useRef, useState } from "react";
import { useQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocDetail } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useBootstrapCollection } from "./useBootstrapCollection";
import { countLogMissedRows, runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { track } from "../lib/analytics";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useWorkspaceArgs, type WorkspaceArgs as StoreWorkspaceArgs } from "./useWorkspaceArgs";

import { useMountEffect } from "./useMountEffect";
import { useWatchEffect } from "./useWatchEffect";
const api = _api as any;

function normalizeProjectPath(path: string): string {
  const parts = path.split("/");
  const srcIndex = parts.findIndex((p) => p === "src" || p === "projects" || p === "repos" || p === "code");
  if (srcIndex >= 0 && srcIndex < parts.length - 1) {
    return parts.slice(0, srcIndex + 2).join("/");
  }
  return path;
}

function dedupeProjectPaths(paths: string[]): string[] {
  const byName = new Map<string, string>();
  for (const path of paths) {
    const root = normalizeProjectPath(path);
    const name = root.split("/").filter(Boolean).pop() || path;
    const existing = byName.get(name);
    if (!existing || (path.includes("/src/") && !existing.includes("/src/"))) {
      byName.set(name, path);
    }
  }
  return Array.from(byName.values());
}

// Recent docs: a one-shot bootstrap floor (sync-log-cargo E8). The rest are loaded once into the
// IDB-persisted store cache by the background reconcile below. The server caps
// webListPaginated at a small page (per-doc memory), so we never want the old
// "auto-load every page" behaviour: that held ~totalDocs/pageSize live
// subscriptions PER TAB, and each re-ran on any conversation/author write —
// the dominant webListPaginated invalidation storm (~hundreds/s fleet-wide).
const BOOTSTRAP_PAGE_SIZE = 24;
const RECONCILE_PAGE_SIZE = 24;
// Full reconcile is a one-shot crawl, not a live subscription. The durable
// throttle (syncMeta.backfilledAt, written by runReconcileCrawl on completion)
// makes a fresh launch within the window skip the crawl and serve from the
// hydrated IDB cache — same as tasks. The sync log's cargo keeps every doc fresh.
// Demoted safety net — see useSyncTasks.ts / sync-log-migration.md D9.
const RECONCILE_THROTTLE_MS = 24 * 60 * 60 * 1000;
const RECONCILE_PAGE_DELAY_MS = 60; // pace the crawl so it never bursts the backend

type WorkspaceArgs =
  | Extract<StoreWorkspaceArgs, { workspace: "team" }>
  | Extract<StoreWorkspaceArgs, { workspace: "personal" }>
  | "skip";

/**
 * Shared docs sync — used by both web and mobile.
 *
 * Lazy + heavily cached: a one-shot bootstrap floor seeds the most-recent page
 * (synced as a delta so it never prunes the cache; the sync log's cargo keeps
 * it fresh), and a throttled,
 * paced background crawl loads the full set once and syncs it as a delta with
 * a workspace-scoped absent-prune (authoritative for this workspace → removes
 * server-side deletes without touching other workspaces' cached docs).
 * Everything else is served from the persisted store cache, so re-mounts and
 * older docs cost nothing.
 */
export function useSyncDocsPaginated(wsArgs: WorkspaceArgs) {
  const convex = useConvex();
  const syncTable = useInboxStore((s) => s.syncTable);

  // 1) BOOTSTRAP FLOOR: the first (most-recent) page, ONE-SHOT per workspace
  //    per page session (sync-log-cargo E8) — no longer a live subscription
  //    that re-pushes the page on every doc write. The sync log's cargo carries
  //    later changes; docProjectPaths is left to the full reconcile so it
  //    reflects ALL docs, not just this page.
  const [results, setResults] = useState<any[] | undefined>(undefined);
  const { ready } = useBootstrapCollection(
    "docs",
    api.docs.webListPaginated,
    wsArgs === "skip" ? "skip" : { ...(wsArgs as object), paginationOpts: { numItems: BOOTSTRAP_PAGE_SIZE, cursor: null } },
    { select: (r: any) => r?.page, liveLoadingScope: "docs", onRows: setResults },
  );

  // BODY PREFETCH for the recent page: the list channels are thin (bodies
  // stripped server-side), so without this a doc's first open always spins on
  // the detail round trip. Backfill content into the persisted docDetails
  // cache for any recent doc whose cached body is missing or stale, so opening
  // a recent doc paints synchronously. Small paced batches — the server loads
  // full rows into its isolate heap, so one big batch is the outage shape.
  // Steady-state cost is zero: an up-to-date body (updated_at match) is
  // skipped, and each (id, updated_at) is attempted once per session.
  const attemptedRef = useRef(new Map<string, number>());
  const prefetchHydrated = useInboxStore((s) => s.clientStateInitialized);
  const wsSkip = wsArgs === "skip";
  useWatchEffect(() => {
    if (!prefetchHydrated || wsSkip || !results?.length) return;
    const { docDetails } = useInboxStore.getState();
    const rowById = new Map<string, any>();
    for (const row of results as any[]) {
      const cached = docDetails[row._id];
      if (cached?.content !== undefined && (cached.updated_at ?? 0) >= row.updated_at) continue;
      if (attemptedRef.current.get(row._id) === row.updated_at) continue;
      rowById.set(row._id, row);
    }
    if (rowById.size === 0) return;
    for (const [id, row] of rowById) attemptedRef.current.set(id, row.updated_at);
    let cancelled = false;
    (async () => {
      const ids = [...rowById.keys()];
      for (let i = 0; i < ids.length && !cancelled; i += 6) {
        const batch = ids.slice(i, i + 6);
        try {
          const { bodies } = await convex.query(api.docs.webGetBodies, { ids: batch });
          if (cancelled) return;
          const store = useInboxStore.getState();
          for (const body of bodies ?? []) {
            // Compose a list-shaped row + body so the cached detail can carry
            // the whole read view (title, dates, labels come from the thin
            // row); the live detail query enriches with joins on open.
            store.syncRecord("docDetails", body._id, {
              ...rowById.get(body._id),
              ...body,
              _cachedAt: Date.now(),
            });
          }
        } catch {
          // transient — the ids stay marked attempted; the next updated_at
          // change (or the doc's own open) retries
        }
        if (i + 6 < ids.length) await new Promise((r) => setTimeout(r, 150));
      }
    })();
    return () => { cancelled = true; };
  }, [convex, results, prefetchHydrated, wsSkip]);

  // 2) BACKGROUND RECONCILE: crawl every page once (one-shot queries, NOT live
  //    subscriptions), then sync the full set with a workspace-scoped
  //    absent-prune to drop deletions and fill the cache. Throttled per
  //    workspace + paced. A nonce ticks every throttle window so long-lived
  //    sessions still pick up docs deleted elsewhere (the sync log's cargo
  //    already catches new/updated recent docs).
  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  // Gate on hydration so the durable watermark is restored before we decide
  // whether to crawl — else a reload would full-crawl against an empty syncMeta
  // before the persisted backfilledAt loads. Mirrors useSyncTasks.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const [reconcileNonce, setReconcileNonce] = useState(0);
  useMountEffect(() => {
    const id = setInterval(() => setReconcileNonce((n) => n + 1), RECONCILE_THROTTLE_MS);
    return () => clearInterval(id);
  });
  useWatchEffect(() => {
    if (!hydrated) return;
    // Healed-rows metric (sync-log-migration.md D12): only meaningful after the
    // first full backfill — a cold crawl would count every row as "missed".
    const docsWarm = !!useInboxStore.getState().syncMeta[syncMetaKey("docs", wsKey)]?.backfilledAt;
    const healedRef = { count: 0 };
    runReconcileCrawl({
      namespace: "docs",
      wsKey,
      throttleMs: RECONCILE_THROTTLE_MS,
      pageDelayMs: RECONCILE_PAGE_DELAY_MS,
      maxPages: 1000,
      fetchPage: async (cursor) => {
        const page = await convex.query(api.docs.webListPaginated, {
          ...(wsArgs as object),
          paginationOpts: { numItems: RECONCILE_PAGE_SIZE, cursor },
        });
        return { rows: page.page ?? [], isDone: page.isDone, continueCursor: page.continueCursor };
      },
      onPage: (rows) => {
        if (docsWarm) healedRef.count += countLogMissedRows(useInboxStore.getState().docs, rows);
        // Authorized crawl rows are visible by definition — lift excludes
        // (feed prunes, team-revocation purges) before the delta merge, or the
        // engine drops them forever. Heals team rejoin (review C7).
        useInboxStore.getState().clearFeedExcludes("docs", rows.map((r: any) => String(r._id)));
        syncTable("docs", rows, { isDelta: true });
      },
      onComplete: (all, complete) => {
        if (docsWarm) {
          // Removal-condition metric — zeros included (see useSyncTasks).
          track("synclog_crawl_healed", { namespace: "docs", count: healedRef.count });
          console.info(`[synclog] docs safety-net crawl healed ${healedRef.count} row(s)`);
        }
        // `complete` is false when the crawl stopped early OR resumed from a
        // mid-crawl checkpoint (reconcileCrawl's reload-resume): `all` is then
        // only the tail of the table, and neither the derived project paths nor
        // the absent-prune below may treat it as the whole workspace.
        const projectPaths = dedupeProjectPaths([
          ...new Set(all.map((d) => d.project_path).filter(Boolean) as string[]),
        ]);
        // Only attach `extra` when the derived paths actually changed. `extra`
        // forces syncTable past its no-op guard, so passing it every crawl would
        // rewrite `docs` (and re-persist it) every 5 minutes even when nothing
        // changed. When paths are stable, a plain sync lets the guard short-
        // circuit an unchanged crawl entirely.
        const prevPaths = useInboxStore.getState().docProjectPaths;
        const pathsChanged =
          complete &&
          (prevPaths.length !== projectPaths.length ||
            projectPaths.some((p, i) => prevPaths[i] !== p));
        // The crawl is the COMPLETE set for this workspace, so docs of this
        // workspace absent from it are server-side deletions — prune them
        // (scoped, so the other workspace's cached docs are untouched). This is
        // the only channel by which a doc deletion reaches a client's cache.
        const pruneAbsentScope =
          wsArgs === "skip" || !complete
            ? undefined
            : (wsArgs as any).workspace === "team"
              ? (d: any) => d.team_id === (wsArgs as any).team_id
              : (d: any) => !d.team_id;
        const opts = pathsChanged
          ? { isDelta: true, pruneAbsentScope, extra: { docProjectPaths: projectPaths } }
          : { isDelta: true, pruneAbsentScope };
        useInboxStore.getState().syncTable("docs", all, opts);
      },
    });
  }, [convex, wsKey, reconcileNonce, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ready };
}

/**
 * Web-specific wrapper — reads workspace args from the store.
 */
export function useSyncDocs() {
  return useSyncDocsPaginated(useWorkspaceArgs());
}

/**
 * Cross-team mention index for docs — see useSyncMentionTasks for context.
 */
export function useSyncMentionDocs() {
  const syncMentionIndex = useInboxStore((s) => s.syncMentionIndex);
  const result = useQuery(api.docs.webMentionList, { workspace: "all" } as any);

  useConvexSync(result, useCallback((data: any) => {
    syncMentionIndex("docs", data?.items ?? []);
  }, [syncMentionIndex]));
}

// Returns the raw query result so callers can tell the three states apart:
//   undefined → still loading
//   null      → resolved, but no accessible doc for this id (e.g. a stale or
//               cross-table id from a malformed /docs/<id> link)
//   object    → the doc detail
// A fresh _cachedAt on every live push would defeat syncRecord's no-op bail
// (and re-persist the row each time the subscription re-runs); day-grain
// recency is all the LRU retention needs.
const CACHED_AT_GRAIN_MS = 6 * 60 * 60 * 1000;

export function useSyncDocDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetDocDetail,
    id ? { id: id as any } : "skip"
  );
  const syncRecord = useInboxStore((s) => s.syncRecord);

  useConvexSync(data, useCallback((d: any) => {
    if (!id) return;
    if (d) {
      // The detail row spreads the whole doc, embedding included — dead weight
      // for a cache that now persists (the registry hydrateRow sheds it at
      // boot; shedding here keeps it out of memory and disk in the first place).
      const { embedding: _m, ...row } = d;
      const prev = useInboxStore.getState().docDetails[id]?._cachedAt ?? 0;
      row._cachedAt = Date.now() - prev < CACHED_AT_GRAIN_MS ? prev : Date.now();
      syncRecord("docDetails", id, row as unknown as DocDetail);
    } else if (d === null && useInboxStore.getState().docDetails[id]) {
      // Deleted or access revoked — a persisted body must not outlive the
      // server's answer, or the page renders stale content forever.
      useInboxStore.getState().dropDocDetail(id);
    }
  }, [id, syncRecord]));

  return data as DocDetail | null | undefined;
}
