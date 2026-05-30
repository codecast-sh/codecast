import { useCallback, useEffect, useState } from "react";
import { useQuery, usePaginatedQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocDetail } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useMountEffect } from "./useMountEffect";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

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

// Only the most-recent page is held LIVE (a single subscription). The rest is
// loaded once into the IDB-persisted store cache by the background reconcile
// below. We never want the old "auto-load every remaining page" behaviour: it
// fanned every docs mount/refresh into ~totalDocs/pageSize sequential
// round-trips against the (already saturated) backend, and held that many live
// subscriptions per tab — each re-running on any doc write.
const LIVE_PAGE_SIZE = 24;
const RECONCILE_PAGE_SIZE = 24;
// Full reconcile is a one-shot crawl, not a live subscription. Throttle it per
// workspace so re-mounts and reactive re-renders lean on the cache instead of
// re-crawling every time.
export const RECONCILE_THROTTLE_MS = 5 * 60 * 1000;
const RECONCILE_PAGE_DELAY_MS = 200; // pace the crawl so it never bursts the backend
// Hard ceiling on pages per crawl so a runaway cursor can never walk forever.
export const MAX_RECONCILE_PAGES = 1000;
const reconcileLastRun = new Map<string, number>();

/** Throttle gate: only start a fresh crawl once the window has elapsed. */
export function shouldReconcile(lastRunAt: number, now: number, throttleMs: number): boolean {
  return now - lastRunAt >= throttleMs;
}

type DocsPage = { page?: any[]; isDone?: boolean; continueCursor?: string | null };

/**
 * Bounded one-shot crawl of every docs page. Stops at `isDone`, on a missing
 * cursor, when cancelled, or at `maxPages` — it never loops unbounded. Returns
 * the accumulated docs, or null when the crawl was aborted (cancelled or a
 * fetch threw) so the caller can skip the prune-on-snapshot.
 */
export async function crawlAllPages(
  fetchPage: (cursor: string | null) => Promise<DocsPage | null | undefined>,
  opts: {
    maxPages?: number;
    isCancelled?: () => boolean;
    onPage?: () => Promise<void> | void;
  } = {}
): Promise<any[] | null> {
  const maxPages = opts.maxPages ?? MAX_RECONCILE_PAGES;
  const all: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    if (opts.isCancelled?.()) return null;
    let page: DocsPage | null | undefined;
    try {
      page = await fetchPage(cursor);
    } catch {
      return null;
    }
    if (opts.isCancelled?.() || !page) return null;
    all.push(...(page.page ?? []));
    if (page.isDone || !page.continueCursor) break;
    cursor = page.continueCursor;
    if (opts.onPage) await opts.onPage();
  }
  return all;
}

type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team" }
  | { workspace: "personal" }
  | "skip";

/**
 * Shared docs sync — used by both web and mobile.
 *
 * Lazy + heavily cached: a single LIVE subscription keeps the most-recent page
 * fresh (synced as a delta so it never prunes the cache), and a throttled,
 * paced background crawl loads the full set once and snapshot-syncs it
 * (authoritative → prunes server-side deletes). Everything else is served from
 * the persisted store cache, so re-mounts and older docs cost nothing — and
 * opening/refreshing the docs view never walks every page on every mount.
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

  // 2) BACKGROUND RECONCILE: crawl every page once (one-shot queries, NOT live
  //    subscriptions), then snapshot-sync the full set to prune deletions and
  //    fill the cache. Throttled per workspace + paced + page-budget capped. A
  //    nonce ticks every throttle window so long-lived sessions still pick up
  //    docs deleted elsewhere (the live first page already catches recent ones).
  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  const [reconcileNonce, setReconcileNonce] = useState(0);
  useMountEffect(() => {
    const id = setInterval(() => setReconcileNonce((n) => n + 1), RECONCILE_THROTTLE_MS);
    return () => clearInterval(id);
  });
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (wsArgs === "skip") return;
    const last = reconcileLastRun.get(wsKey) ?? 0;
    if (!shouldReconcile(last, Date.now(), RECONCILE_THROTTLE_MS)) return;
    reconcileLastRun.set(wsKey, Date.now());

    let cancelled = false;
    (async () => {
      const all = await crawlAllPages(
        (cursor) =>
          convex.query(api.docs.webListPaginated, {
            ...(wsArgs as object),
            paginationOpts: { numItems: RECONCILE_PAGE_SIZE, cursor },
          }),
        {
          isCancelled: () => cancelled,
          onPage: () => new Promise((r) => setTimeout(r, RECONCILE_PAGE_DELAY_MS)),
        }
      );
      // Aborted mid-crawl (cancelled or backend hiccup): don't snapshot a
      // partial set — that would prune real docs. Allow a retry next mount.
      if (all === null) {
        if (!cancelled) reconcileLastRun.set(wsKey, 0);
        return;
      }
      if (cancelled) return;
      const projectPaths = dedupeProjectPaths([
        ...new Set(all.map((d) => d.project_path).filter(Boolean) as string[]),
      ]);
      useInboxStore
        .getState()
        .syncTable("docs", all, { extra: { docProjectPaths: projectPaths } });
    })();

    return () => {
      cancelled = true;
    };
  }, [convex, wsKey, reconcileNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ready: status !== "LoadingFirstPage" };
}

/**
 * Web-specific wrapper — reads workspace args from the store.
 */
export function useSyncDocs() {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore((s) => s.clientStateInitialized);

  const wsArgs: WorkspaceArgs = !initialized ? "skip" : activeTeamId
    ? { team_id: activeTeamId, workspace: "team" as const }
    : { workspace: "personal" as const };

  return useSyncDocsPaginated(wsArgs);
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
