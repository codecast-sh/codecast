import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { collectionRowValidator } from "../store/clientSyncRegistry";
import { useConvexSync } from "./useConvexSync";
import { useWatchEffect } from "./useWatchEffect";
import { runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";

const api = _api as any;

// How long the delta window can grow before we bump the cursor. Reactive
// ticks within this window don't resubscribe (cheap), but the result set is
// bounded by ~CURSOR_REFRESH_MS of accumulated changes. 30s strikes a
// balance between resub churn and reactive payload size.
const CURSOR_REFRESH_MS = 30_000;

// Full reconcile crawl — pages through EVERY task in the workspace so the store
// is complete, not just the live channel's most-recent window. Each page is a
// one-shot `convex.query()` (the same primitive the docs reconcile uses), NOT a
// live subscription, so it never recreates the per-page subscription storm.
// We request a large page; the WS transport may return fewer rows per response
// (byte budget) and just hands back a continueCursor — pagination is driven by
// the server's `isDone`, so the crawl always reaches the true end regardless.
const RECONCILE_PAGE_SIZE = 1000;
const RECONCILE_PAGE_DELAY_MS = 5; // minimal pacing — cold backfill should be fast, not polite
// Safety-net interval, NOT the freshness path. The live delta channel below keeps
// the store current within ~30s; this crawl only re-verifies completeness. The
// FIRST crawl per workspace is a full backfill (cold cache); every crawl after is
// incremental (`since` the persisted watermark), so it pages a handful of changed
// rows, not the whole table. Durable throttle (syncMeta.backfilledAt) means it
// won't re-run on every launch — the old 5-min full sweep was the "syncing 4,529".
const RECONCILE_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Core task sync — pulls tasks for the workspace into the store.
 * Shared between web and mobile. Filtering happens client-side.
 *
 * Uses a delta cursor: the first subscription fetches a full snapshot, then
 * subsequent reactive runs receive only tasks whose `updated_at` exceeds the
 * cursor. The cursor is bumped periodically (CURSOR_REFRESH_MS) so the
 * reactive window stays small without resubscribing on every change.
 *
 * The live "activeSession" overlay is fetched as a separate small query so
 * that daemon heartbeats (which churn managed_sessions every ~30s) don't
 * invalidate the multi-MB task payload.
 */
export function useSyncTasksWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);
  const convex = useConvex();
  // Gate the watermark reads on hydration so the cursor/backfill we resume from is
  // the restored one, not an empty map mid-hydration (which would re-snapshot +
  // re-crawl unnecessarily). syncMeta is on the critical hydration path.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);

  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  const metaKey = syncMetaKey("tasks", wsKey); // shared key — live channel + crawl must match
  // The live channel is the COMPLETENESS FLOOR, not a delta resume. Cold start
  // and workspace switch ALWAYS do a full webList snapshot (300 most-recent + every
  // assignee-rescued task). We deliberately do NOT seed `since` from the persisted
  // watermark: a delta-on-cold-start silently misses any task the cache happens to
  // lack ("3 of my 5 tasks" regression). The cursor only advances WITHIN a session
  // (below) to trim the reactive payload; it resets to undefined on every load and
  // on workspace switch, so the floor is re-established every time. The persisted
  // watermark drives only the background reconcile crawl's incremental top-up.
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const lastSeenCursor = useRef<number | undefined>(undefined);
  const lastWsKey = useRef<string>(wsKey);
  if (lastWsKey.current !== wsKey) {
    lastWsKey.current = wsKey;
    if (cursor !== undefined) setCursor(undefined);
    lastSeenCursor.current = undefined;
  }

  const tasksResult = useQuery(api.tasks.webList,
    wsArgs === "skip" ? "skip" : {
      ...wsArgs,
      include_derived: true,
      ...(cursor !== undefined ? { since: cursor } : {}),
    }
  );
  const activeMap = useQuery(api.tasks.webActiveSessions,
    wsArgs === "skip" ? "skip" : {}
  );

  // Sync tasks WITHOUT the activeSession overlay so daemon heartbeats
  // (which churn activeMap every ~30s) don't re-sync the entire task table.
  const taskData = useMemo(() => {
    if (tasksResult === undefined) return undefined;
    const items: any[] = tasksResult.items ?? tasksResult;
    return { items, isDelta: !!tasksResult.isDelta, cursor: tasksResult.cursor };
  }, [tasksResult]);

  // Live channel = DELTA OVERLAY (never prune), even on the first page. EVERY
  // write to `tasks` is delta — enforced by isDelta:true in SYNC_REGISTRY — so
  // neither this most-recent 300-row live window nor the reconcile crawl below
  // can wipe the cache; they only ADD/UPDATE. Deletions arrive as deltas
  // (status="dropped") and are hidden by read-time filters. Mirrors docs/sessions.
  useConvexSync(taskData, useCallback((data: any) => {
    syncTable("tasks", data.items, { isDelta: true });
    if (typeof data.cursor === "number") lastSeenCursor.current = data.cursor;
  }, [syncTable]));

  // Active sessions stored separately — lightweight update, no task resync.
  useConvexSync(activeMap, useCallback((data: any) => {
    if (data) useInboxStore.setState({ taskActiveSessions: data });
  }, []));

  // Header SyncStatusChip: spin while the LIVE task list loads its first payload
  // (not the background reconcile crawl below, which pages for minutes). This
  // hook is page-scoped, so clear on unmount — else navigating away mid-load
  // would strand the chip lit on every other page.
  useWatchEffect(() => {
    useInboxStore.getState().setLiveLoading("tasks", tasksResult === undefined);
    return () => useInboxStore.getState().setLiveLoading("tasks", false);
  }, [tasksResult]);

  // Periodically promote the latest seen cursor WITHIN this session only. Each
  // promotion trims the reactive payload (discards already-shipped rows), but it
  // is NOT persisted — it resets to undefined on the next load so the live channel
  // re-establishes the full snapshot floor. The crawl owns the durable watermark.
  useEffect(() => {
    const id = setInterval(() => {
      const next = lastSeenCursor.current;
      if (next !== undefined && next !== cursor) setCursor(next);
    }, CURSOR_REFRESH_MS);
    return () => clearInterval(id);
  }, [cursor]);

  // RECONCILE: page through webListPaginated to backfill everything beyond the
  // live channel's most-recent window. The FIRST crawl per workspace is a full
  // backfill (cold cache, no watermark); every crawl after passes `since` = the
  // persisted watermark, so it pages only CHANGED rows — a handful, not all 4,529.
  // Every page is an additive delta overlay (isDelta in SYNC_REGISTRY) — never
  // prunes — so a short/truncated crawl can't gut the cache. Deletions arrive as
  // status="dropped" deltas hidden by read-time filters. The durable throttle
  // (syncMeta.backfilledAt, set on completion) means a fresh launch within the
  // window skips the crawl entirely and serves from the hydrated IDB cache.
  // Shared with the docs crawl via runReconcileCrawl — see reconcileCrawl.ts.
  const [reconcileNonce, setReconcileNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setReconcileNonce((n) => n + 1), RECONCILE_THROTTLE_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!hydrated) return; // resume from the restored watermark, not an empty one
    // Incremental top-up only AFTER a full backfill exists for this workspace.
    // Before that, `since` stays undefined so the first pass loads everything.
    const meta = useInboxStore.getState().syncMeta[metaKey];
    const crawlSince = meta?.backfilledAt ? meta.cursor : undefined;
    runReconcileCrawl({
      namespace: "tasks",
      wsKey,
      throttleMs: RECONCILE_THROTTLE_MS,
      pageDelayMs: RECONCILE_PAGE_DELAY_MS,
      maxPages: 4000,
      fetchPage: async (cursor) => {
        const page = await convex.query(api.tasks.webListPaginated, {
          ...(wsArgs as object),
          include_derived: true,
          ...(crawlSince !== undefined ? { since: crawlSince } : {}),
          paginationOpts: { numItems: RECONCILE_PAGE_SIZE, cursor },
        });
        return { rows: page.page ?? [], isDone: page.isDone, continueCursor: page.continueCursor };
      },
      onPage: (rows) => syncTable("tasks", rows, { isDelta: true }),
      onComplete: (all) => useInboxStore.getState().syncTable("tasks", all, { isDelta: true }),
    });
  }, [convex, wsKey, reconcileNonce, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  return { hasMore: false, loadMore: () => {}, ready: tasksResult !== undefined };
}

/**
 * Web wrapper — pulls workspace args from clientState.
 */
export function useSyncTasks() {
  return useSyncTasksWithArgs(useWorkspaceArgs());
}

/**
 * Cross-team mention index for tasks — pulls a minimal-field snapshot of
 * every task in every team the user belongs to, plus their personal tasks.
 * Lives in `store.mentionIndex.tasks` so it doesn't fight the active-team
 * `store.tasks` collection that page views render.
 */
export function useSyncMentionTasks() {
  const syncMentionIndex = useInboxStore((s) => s.syncMentionIndex);
  const result = useQuery(api.tasks.webMentionList, { workspace: "all" } as any);

  useConvexSync(result, useCallback((data: any) => {
    syncMentionIndex("tasks", data?.items ?? []);
  }, [syncMentionIndex]));
}

export function useSyncTaskDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetTaskDetail,
    id ? { id: id as any } : "skip"
  );
  const syncRecord = useInboxStore((s) => s.syncRecord);

  useConvexSync(data, useCallback((d: any) => {
    // Only persist genuine tasks. The detail route can be loaded with a foreign
    // id (/tasks/<conversationId>); storing whatever comes back plants a phantom
    // task in the never-pruned cache (see validRow in clientSyncRegistry).
    if (id && d && collectionRowValidator("tasks")!(d)) syncRecord("tasks", id, d);
  }, [id, syncRecord]));

  return data;
}
