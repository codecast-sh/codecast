import { useCallback, useEffect, useState } from "react";
import { useQuery, usePaginatedQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocDetail } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWatchEffect } from "./useWatchEffect";
import { runReconcileCrawl } from "./reconcileCrawl";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useWorkspaceArgs, type WorkspaceArgs as StoreWorkspaceArgs } from "./useWorkspaceArgs";

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

// Recent docs held LIVE (one subscription). The rest are loaded once into the
// IDB-persisted store cache by the background reconcile below. The server caps
// webListPaginated at a small page (per-doc memory), so we never want the old
// "auto-load every page" behaviour: that held ~totalDocs/pageSize live
// subscriptions PER TAB, and each re-ran on any conversation/author write —
// the dominant webListPaginated invalidation storm (~hundreds/s fleet-wide).
const LIVE_PAGE_SIZE = 24;
const RECONCILE_PAGE_SIZE = 24;
// Full reconcile is a one-shot crawl, not a live subscription. The durable
// throttle (syncMeta.backfilledAt, written by runReconcileCrawl on completion)
// makes a fresh launch within the window skip the crawl and serve from the
// hydrated IDB cache — same as tasks. The live first page keeps recent docs fresh.
const RECONCILE_THROTTLE_MS = 30 * 60 * 1000;
const RECONCILE_PAGE_DELAY_MS = 60; // pace the crawl so it never bursts the backend

type WorkspaceArgs =
  | Extract<StoreWorkspaceArgs, { workspace: "team" }>
  | Extract<StoreWorkspaceArgs, { workspace: "personal" }>
  | "skip";

/**
 * Shared docs sync — used by both web and mobile.
 *
 * Lazy + heavily cached: a single LIVE subscription keeps the most-recent page
 * fresh (synced as a delta so it never prunes the cache), and a throttled,
 * paced background crawl loads the full set once and syncs it as a snapshot
 * (authoritative → prunes server-side deletes). Everything else is served from
 * the persisted store cache, so re-mounts and older docs cost nothing.
 */
export function useSyncDocsPaginated(wsArgs: WorkspaceArgs) {
  const convex = useConvex();
  const syncTable = useInboxStore((s) => s.syncTable);

  // 1) LIVE: only the first (most-recent) page. No auto-load-all.
  const { results, status } = usePaginatedQuery(
    api.docs.webListPaginated,
    wsArgs === "skip" ? "skip" : wsArgs,
    { initialNumItems: LIVE_PAGE_SIZE }
  );

  // Sync the live page as a DELTA: overlay recent docs onto the cache without
  // pruning the older cached docs (snapshot mode would drop everything not on
  // this page). docProjectPaths is left to the full reconcile so it reflects
  // ALL docs, not just this page.
  useConvexSync(
    status !== "LoadingFirstPage" ? results : undefined,
    useCallback((docs: any) => {
      syncTable("docs", docs, { isDelta: true });
    }, [syncTable])
  );

  // Header SyncStatusChip: spin only while the LIVE first page is loading on a
  // cold open. The background reconcile crawl below is housekeeping (it pages
  // every doc at a throttled pace, for minutes) and must NOT drive the chip.
  useWatchEffect(() => {
    useInboxStore.getState().setLiveLoading("docs", status === "LoadingFirstPage");
  }, [status]);

  // 2) BACKGROUND RECONCILE: crawl every page once (one-shot queries, NOT live
  //    subscriptions), then snapshot-sync the full set to prune deletions and
  //    fill the cache. Throttled per workspace + paced. A nonce ticks every
  //    throttle window so long-lived sessions still pick up docs deleted
  //    elsewhere (the live first page already catches new/updated recent docs).
  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  // Gate on hydration so the durable watermark is restored before we decide
  // whether to crawl — else a reload would full-crawl against an empty syncMeta
  // before the persisted backfilledAt loads. Mirrors useSyncTasks.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const [reconcileNonce, setReconcileNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setReconcileNonce((n) => n + 1), RECONCILE_THROTTLE_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
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
      onPage: (rows) => syncTable("docs", rows, { isDelta: true }),
      onComplete: (all) => {
        const projectPaths = dedupeProjectPaths([
          ...new Set(all.map((d) => d.project_path).filter(Boolean) as string[]),
        ]);
        // Only attach `extra` when the derived paths actually changed. `extra`
        // forces syncTable past its no-op guard, so passing it every crawl would
        // rewrite `docs` (and re-persist it) every 5 minutes even when nothing
        // changed. When paths are stable, a plain snapshot lets the guard short-
        // circuit an unchanged crawl entirely.
        const prevPaths = useInboxStore.getState().docProjectPaths;
        const pathsChanged =
          prevPaths.length !== projectPaths.length ||
          projectPaths.some((p, i) => prevPaths[i] !== p);
        useInboxStore
          .getState()
          .syncTable("docs", all, pathsChanged ? { isDelta: true, extra: { docProjectPaths: projectPaths } } : { isDelta: true });
      },
    });
  }, [convex, wsKey, reconcileNonce, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ready: status !== "LoadingFirstPage" };
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

export function useSyncDocDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetDocDetail,
    id ? { id: id as any } : "skip"
  );
  const syncRecord = useInboxStore((s) => s.syncRecord);

  useConvexSync(data, useCallback((d: any) => {
    if (id) syncRecord("docDetails", id, d as unknown as DocDetail);
  }, [id, syncRecord]));
}
