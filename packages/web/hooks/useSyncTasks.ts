import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
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
const RECONCILE_PAGE_SIZE = 500;
const RECONCILE_PAGE_DELAY_MS = 120; // pace the crawl so it never bursts the backend
const RECONCILE_THROTTLE_MS = 5 * 60 * 1000;
// Crawl lifecycle is managed at module scope, NOT via React effect cleanup —
// the effect re-runs frequently (WS reconnect / project-path flicker churn) and
// cancelling the in-flight crawl on every re-render meant it never finished.
//   reconcileDoneAt    — wsKey → last SUCCESSFUL completion (throttle window).
//   reconcileRunningKey — wsKey of the crawl currently in flight, if any.
//   reconcileGen       — bumped only on a real workspace change, so a stale
//                        crawl abandons its writes instead of clobbering the new
//                        workspace's data.
const reconcileDoneAt = new Map<string, number>();
let reconcileRunningKey: string | null = null;
let reconcileGen = 0;

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

  // Reset the cursor whenever workspace args change — switching teams or
  // toggling workspace=all needs a fresh full snapshot.
  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
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

  // Live channel = pure DELTA OVERLAY (never prune), even on the first
  // snapshot. The full reconcile crawl below owns completeness and is the sole
  // authoritative snapshot; if this channel pruned (isDelta:false), its
  // most-recent 300-row window would clobber the reconcile's full set. Mirrors
  // the docs hook (live first page overlays, reconcile snapshots).
  useConvexSync(taskData, useCallback((data: any) => {
    syncTable("tasks", data.items, { isDelta: true });
    if (typeof data.cursor === "number") lastSeenCursor.current = data.cursor;
  }, [syncTable]));

  // Active sessions stored separately — lightweight update, no task resync.
  useConvexSync(activeMap, useCallback((data: any) => {
    if (data) useInboxStore.setState({ taskActiveSessions: data });
  }, []));

  // Periodically promote the latest seen cursor. Each promotion triggers a
  // resubscription with the new `since`, which discards already-shipped rows
  // and keeps the reactive payload trimmed.
  useEffect(() => {
    const id = setInterval(() => {
      const next = lastSeenCursor.current;
      if (next !== undefined && next !== cursor) setCursor(next);
    }, CURSOR_REFRESH_MS);
    return () => clearInterval(id);
  }, [cursor]);

  // FULL RECONCILE: crawl every page of webListPaginated once per workspace
  // (throttled + paced), overlaying each page as it lands so tasks visibly
  // stream in, then snapshot the full set to prune stale / cross-workspace /
  // dropped rows. One-shot convex.query() calls — NOT live subscriptions — so
  // the crawl never recreates the per-page subscription storm. `taskLoadProgress`
  // is published so the UI can show "loading all tasks… N" and never imply the
  // list is complete mid-crawl. A nonce re-crawls every throttle window so
  // long-lived sessions still pick up tasks created/dropped elsewhere.
  const [reconcileNonce, setReconcileNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setReconcileNonce((n) => n + 1), RECONCILE_THROTTLE_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (wsArgs === "skip") return;
    // Recently completed for this workspace → serve from the IDB-cached store.
    if (Date.now() - (reconcileDoneAt.get(wsKey) ?? 0) < RECONCILE_THROTTLE_MS) return;
    // A crawl for THIS workspace is already in flight → let it finish; a
    // same-workspace re-render must not restart or cancel it.
    if (reconcileRunningKey === wsKey) return;

    // Start (and supersede any crawl for a different/old workspace).
    const myGen = ++reconcileGen;
    reconcileRunningKey = wsKey;
    const superseded = () => reconcileGen !== myGen;
    const setProgress = (p: { loading: boolean; loaded: number }) =>
      useInboxStore.setState({ taskLoadProgress: p });

    (async () => {
      // Each page is a one-shot `convex.query()` — same primitive the docs
      // reconcile uses (useSyncDocs). It is NOT a live subscription, so it never
      // recreates the per-page subscription storm that saturated the backend.
      // (Verified against live data: this WS path crawls all ~5.2k Union tasks
      // to the true end — an earlier note claiming it truncates at ~1.5k was
      // wrong; `isDone` is computed server-side, so the transport can't truncate
      // pagination. Auth + deployment URL are handled by the client.)
      const fetchPage = (cursor: string | null) =>
        convex.query(api.tasks.webListPaginated, {
          ...(wsArgs as object),
          include_derived: true,
          paginationOpts: { numItems: RECONCILE_PAGE_SIZE, cursor },
        }) as Promise<{ page: any[]; isDone: boolean; continueCursor: string }>;

      setProgress({ loading: true, loaded: 0 });
      const all: any[] = [];
      let pageCursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let i = 0; i < 4000; i++) {
        // Retry transient page failures with backoff — one hiccup must not
        // abandon the whole crawl and leave a partial list. Give up only after
        // several attempts.
        let page: { page: any[]; isDone: boolean; continueCursor: string } | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (superseded()) return;
          try { page = await fetchPage(pageCursor); break; }
          catch {
            if (attempt === 4) {
              // Persistent failure: don't snapshot a partial set (it would prune
              // real tasks). Leave overlaid pages in place; retry next effect run.
              if (!superseded()) {
                reconcileRunningKey = null;
                setProgress({ loading: false, loaded: all.length });
              }
              return;
            }
            await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
          }
        }
        if (superseded() || !page) return; // a newer workspace crawl took over
        const rows = page.page ?? [];
        all.push(...rows);
        // Overlay each page immediately so the list fills in progressively.
        if (rows.length) syncTable("tasks", rows, { isDelta: true });
        // Convex paginate may return short/empty pages mid-stream (rows can be 0
        // while more remain) — only isDone marks the true end. seenCursors is a
        // belt-and-braces guard against a cursor that never advances.
        const next: string | null = page.continueCursor || null;
        const more = !page.isDone && !!next && !seenCursors.has(next);
        setProgress({ loading: more, loaded: all.length });
        if (!more) break;
        seenCursors.add(next!);
        pageCursor = next;
        await new Promise((r) => setTimeout(r, RECONCILE_PAGE_DELAY_MS));
      }
      if (superseded()) return;
      // Authoritative snapshot: the FULL set is now in hand — prune anything not
      // in it (old workspace after a team switch, dropped tasks, etc.).
      useInboxStore.getState().syncTable("tasks", all, {});
      setProgress({ loading: false, loaded: all.length });
      reconcileDoneAt.set(wsKey, Date.now());
      reconcileRunningKey = null;
    })();
  }, [convex, wsKey, reconcileNonce]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (id && d) syncRecord("tasks", id, d);
  }, [id, syncRecord]));

  return data;
}
