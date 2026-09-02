import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { collectionRowValidator } from "../store/clientSyncRegistry";
import { useConvexSync } from "./useConvexSync";
import { countLogMissedRows, runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { useBootstrapCollection } from "./useBootstrapCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { track } from "../lib/analytics";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";

const api = _api as any;

// Full reconcile crawl — pages through EVERY task in the workspace so the store
// is complete, not just the live channel's most-recent window. Each page is a
// one-shot `convex.query()` (the same primitive the docs reconcile uses), NOT a
// live subscription, so it never recreates the per-page subscription storm.
// We request a large page; the WS transport may return fewer rows per response
// (byte budget) and just hands back a continueCursor — pagination is driven by
// the server's `isDone`, so the crawl always reaches the true end regardless.
const RECONCILE_PAGE_SIZE = 1000;
const RECONCILE_PAGE_DELAY_MS = 5; // minimal pacing — cold backfill should be fast, not polite
// Demoted safety net (docs/architecture/sync-log-migration.md D9/D12): the sync
// log is the catch-up correctness path now; this crawl remains the COLD BACKFILL
// (first run per workspace, scope_added bootstrap, retention resync) and a 24h
// re-verification whose observed healing rate is the removal signal. The healed
// counter in reconcileCrawl logs rows the crawl changed that the log had missed —
// two weeks of zeros in prod is the condition for deleting the periodic schedule.
const RECONCILE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Core task sync — pulls tasks for the workspace into the store.
 * Shared between web and mobile. Filtering happens client-side.
 *
 * The list query is a one-shot bootstrap floor (sync-log-cargo E8); the sync
 * log's cargo carries every later change directly into the store.
 *
 * The live "activeSession" overlay is fetched as a separate small query so
 * that daemon heartbeats (which churn managed_sessions every ~30s) don't
 * invalidate the multi-MB task payload.
 */
// One-shot badge fetch batch size — bounded by webTaskOrigins' server-side cap.
const ORIGIN_BADGE_CHUNK = 150;

export function useSyncTasksWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);
  const convex = useConvex();

  // Dormant origin badges — "who · when" on a task row's session pill when no
  // live session covers it. Fetched ONE-SHOT per conversation id (a dormant
  // session's badge data doesn't change; live rows ride webActiveSessions), so
  // the task list never subscribes to conversation churn — reading conversations
  // inside webList made every message re-run the multi-MB query (isolate memory
  // churn + "too many system operations" timeouts). See tasks.webTaskOrigins.
  const requestedOrigins = useRef<Set<string>>(new Set());
  const fetchOriginBadges = useCallback((rows: any[]) => {
    const have = useInboxStore.getState().taskOriginBadges;
    const need: string[] = [];
    for (const t of rows) {
      const id = t?.created_from_conversation ?? t?.conversation_ids?.[0];
      if (id && !have[id] && !requestedOrigins.current.has(id)) {
        requestedOrigins.current.add(id);
        need.push(id);
      }
    }
    for (let i = 0; i < need.length; i += ORIGIN_BADGE_CHUNK) {
      const chunk = need.slice(i, i + ORIGIN_BADGE_CHUNK);
      convex.query(api.tasks.webTaskOrigins, { conversation_ids: chunk })
        .then((map: any) => {
          if (map && Object.keys(map).length) {
            useInboxStore.setState((s: any) => ({ taskOriginBadges: { ...s.taskOriginBadges, ...map } }));
          }
        })
        // On failure, allow a retry on the next sync tick. Ids the server
        // omitted (inaccessible/gone) stay in requestedOrigins — no refetch loop.
        .catch(() => { for (const id of chunk) requestedOrigins.current.delete(id); });
    }
  }, [convex]);
  // Gate the watermark reads on hydration so the cursor/backfill we resume from is
  // the restored one, not an empty map mid-hydration (which would re-snapshot +
  // re-crawl unnecessarily). syncMeta is on the critical hydration path.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);

  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  const metaKey = syncMetaKey("tasks", wsKey); // shared key — live channel + crawl must match

  // BOOTSTRAP FLOOR (sync-log-cargo E8): webList runs ONCE per workspace per
  // page session as a one-shot — the 300 most-recent rows PLUS every task
  // assigned to you (the completeness floor a cold cache needs; never seeded
  // from a watermark, see the "3 of my 5 tasks" pitfall). It is no longer a
  // live subscription: Convex re-pushes a subscription's whole result on any
  // change, so every edit re-shipped the window to every client. Steady-state
  // freshness rides the sync log — patches apply directly, assignee changes are
  // scope moves — and the 24h crawl below stays as the safety net.
  const { ready } = useBootstrapCollection(
    "tasks",
    api.tasks.webList,
    wsArgs === "skip" ? "skip" : { ...(wsArgs as object), include_derived: true },
    { select: (r: any) => r?.items ?? r, liveLoadingScope: "tasks", onRows: fetchOriginBadges },
  );

  const activeMap = useQuery(api.tasks.webActiveSessions,
    wsArgs === "skip" ? "skip" : {}
  );

  // Active sessions stored separately — lightweight update, no task resync.
  useConvexSync(activeMap, useCallback((data: any) => {
    if (data) useInboxStore.setState({ taskActiveSessions: data });
  }, []));

  // Origin badges for rows that arrive through the sync log (they never pass a
  // list callback): whenever the applier lands cargo, sweep the workspace's
  // task rows (through the enumeration chokepoint) for missing badges and
  // fetch them one-shot. Membership-only reactivity — badge data is stable.
  const applied = useInboxStore((s) => s.syncLogApplyStats.direct + s.syncLogApplyStats.refetch);
  const workspaceTasks = useWorkspaceCollection<any>("tasks", null);
  useEffect(() => {
    if (wsArgs === "skip") return;
    fetchOriginBadges(workspaceTasks);
  }, [applied, workspaceTasks, fetchOriginBadges, wsArgs === "skip"]);

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
    if (!hydrated || wsArgs === "skip") return; // resume from the restored watermark, not an empty one
    // Incremental top-up only AFTER a full backfill exists for this workspace.
    // Before that, `since` stays undefined so the first pass loads everything.
    const meta = useInboxStore.getState().syncMeta[metaKey];
    const crawlSince = meta?.backfilledAt ? meta.cursor : undefined;
    const healedRef = { count: 0 };
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
      onPage: (rows) => {
        if (crawlSince !== undefined) healedRef.count += countLogMissedRows(useInboxStore.getState().tasks, rows);
        // An authorized crawl returning a row proves it is visible again — lift
        // any exclude (feed prune, team-revocation purge) before the delta
        // merge, or the engine drops the row forever (excludes only retire on
        // snapshot omission, which delta channels never produce). This is what
        // makes a team REJOIN heal (review C7).
        useInboxStore.getState().clearFeedExcludes("tasks", rows.map((r: any) => String(r._id)));
        syncTable("tasks", rows, { isDelta: true });
        fetchOriginBadges(rows);
      },
      onComplete: (all) => {
        useInboxStore.getState().clearFeedExcludes("tasks", all.map((r: any) => String(r._id)));
        useInboxStore.getState().syncTable("tasks", all, { isDelta: true });
        // Removal-condition metric (sync-log-migration.md D11/D12): rows an
        // incremental safety-net crawl healed = rows the sync log missed.
        // Emitted on EVERY completed incremental crawl, zeros included — the
        // removal condition is "two weeks of zeros", and absence of nonzero
        // events is indistinguishable from the crawl not running.
        if (crawlSince !== undefined) {
          track("synclog_crawl_healed", { namespace: "tasks", count: healedRef.count });
          console.info(`[synclog] tasks safety-net crawl healed ${healedRef.count} row(s)`);
          healedRef.count = 0;
        }
      },
    });
  }, [convex, wsKey, reconcileNonce, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  return { hasMore: false, loadMore: () => {}, ready };
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

/** Store one task detail row (taskMining.webGetTaskDetail shape: the task plus
 *  its comments). Shared by the detail feeder below and the Threads inbox,
 *  whose payload carries the same rows for every task thread on the page. */
export function ingestTaskDetail(d: any, opts?: { partialComments?: boolean }): void {
  // Only persist genuine tasks. The detail route can be loaded with a foreign
  // id (/tasks/<conversationId>); storing whatever comes back plants a phantom
  // task in the never-pruned cache (see validRow in clientSyncRegistry).
  // Key by the record's OWN _id, never the URL param: canonical task links
  // use short ids (/tasks/ct-123), and syncRecord(key=short_id) would store a
  // second copy of the row under that key — the never-pruned duplicate then
  // double-counts in subtaskProgressOf / taskFamilyIndex.
  if (!d || !collectionRowValidator("tasks")!(d)) return;
  let row = d;
  // A PARTIAL comment set (threads.listMine ships the newest 50) must never
  // shrink a fuller local list: the task page renders the same array, and a
  // truncating merge would drop its older history until the next detail push.
  if (opts?.partialComments) {
    const prev = (useInboxStore.getState().tasks as Record<string, any>)[String(d._id)];
    const prevComments: any[] = prev?.comments ?? [];
    if (prevComments.length > 0) {
      const incoming = new Set((d.comments ?? []).map((c: any) => String(c._id)));
      const keep = prevComments.filter((c: any) => !incoming.has(String(c._id)));
      if (keep.length > 0) {
        row = { ...d, comments: [...keep, ...(d.comments ?? [])].sort((a: any, b: any) => a.created_at - b.created_at) };
      }
    }
  }
  useInboxStore.getState().syncRecord("tasks", String(row._id), row);
}

export function useSyncTaskDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetTaskDetail,
    id ? { id: id as any } : "skip"
  );

  useConvexSync(data, ingestTaskDetail);

  return data;
}
