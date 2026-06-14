import { useCallback, useEffect, useRef } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";

// Cross-entity change feed — client catch-up.
//
// The companion to the per-table live subscriptions. Those keep an ONLINE client
// fresh; this catches up a client that was AWAY (backgrounded tab frozen, laptop
// asleep, socket wedged) on EVERY change since it last looked — across
// conversations, tasks, docs and plans, INCLUDING deletes, through one cheap
// query. See convex/changeFeed.ts for the server side.
//
// Flow: ask getChangesSince(cursor) for the set of entity ids that changed, batch
// the ids by type, fetch their CURRENT state (the *byIds queries), upsert what
// came back and prune what didn't. The cursor is a `seq` (server Date.now()),
// persisted forward-only in syncMeta; we re-query with a small overlap so a
// commit-reorder straggler or page-boundary tie is re-seen, harmless because
// every apply is idempotent (upsert / prune by id).
//
// Coexists with the dismiss/stash reconcile crawls in useSyncInboxSessions for
// now (both idempotent); those become redundant once this is validated in prod.

type Collection = "sessions" | "tasks" | "docs" | "plans";

const ENTITY_COLLECTION: Record<string, Collection> = {
  conversations: "sessions",
  tasks: "tasks",
  docs: "docs",
  plans: "plans",
};

const COLLECTIONS: Collection[] = ["sessions", "tasks", "docs", "plans"];

// The cursor lives under its own syncMeta key (the feed is per-user, not
// per-workspace). v1 — bump to force every client to re-bootstrap its cursor.
const CHANGE_FEED_META_KEY = "changefeed:v1";
// Re-query this far below the saved cursor so an out-of-order straggler is re-seen.
const OVERLAP_MS = 10_000;
const FEED_LIMIT = 1000;
const MAX_FEED_PAGES = 50;
// Backstop interval; the real triggers are wake/focus/online. The live subs
// handle steady-state freshness, so this only needs to be a safety net.
const FEED_TICK_MS = 45_000;

export type FeedChange = { entity_type: string; entity_id: string; op: "upsert" | "delete" };

// Pure: collapse a page of change events into per-collection upsert/delete id
// lists. Later events for an id win (one row per entity is fetched either way).
// Unit-tested in useSyncChangeFeed.test.ts.
export function planFeedApply(changes: FeedChange[]): Record<Collection, { upsertIds: string[]; deleteIds: string[] }> {
  const plan: Record<Collection, { upsertIds: string[]; deleteIds: string[] }> = {
    sessions: { upsertIds: [], deleteIds: [] },
    tasks: { upsertIds: [], deleteIds: [] },
    docs: { upsertIds: [], deleteIds: [] },
    plans: { upsertIds: [], deleteIds: [] },
  };
  const latest = new Map<string, { coll: Collection; op: "upsert" | "delete" }>();
  for (const c of changes) {
    const coll = ENTITY_COLLECTION[c.entity_type];
    if (!coll) continue;
    latest.set(c.entity_id, { coll, op: c.op });
  }
  for (const [id, { coll, op }] of latest) {
    if (op === "delete") plan[coll].deleteIds.push(id);
    else plan[coll].upsertIds.push(id);
  }
  return plan;
}

// Per-collection batch fetch of CURRENT state for a set of ids. Each returns rows
// in the exact shape its live channel syncs, so syncTable merges them cleanly.
async function batchGet(convex: any, coll: Collection, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  switch (coll) {
    case "sessions":
      return (await convex.query(api.conversations.getInboxSessionsByIds, { ids }))?.sessions ?? [];
    case "tasks":
      return (await convex.query(api.tasks.webGetByIds, { ids }))?.items ?? [];
    case "docs":
      return (await convex.query(api.docs.webGetByIds, { ids }))?.docs ?? [];
    case "plans":
      return (await convex.query(api.plans.webGetByIds, { ids })) ?? [];
  }
}

async function applyPage(convex: any, changes: FeedChange[]): Promise<void> {
  const plan = planFeedApply(changes);
  const store = useInboxStore.getState();
  for (const coll of COLLECTIONS) {
    const { upsertIds, deleteIds } = plan[coll];
    if (deleteIds.length) store.pruneFeedEntities(coll, deleteIds);
    if (!upsertIds.length) continue;
    const rows = await batchGet(convex, coll, upsertIds);
    // Lift any prior exclude so a re-shared / restored entity isn't skipped by
    // the delta merge, THEN upsert current state.
    store.clearFeedExcludes(coll, upsertIds);
    if (rows.length) store.syncTable(coll, rows as any, { isDelta: true } as any);
    // An upsert id the byIds query did NOT return is gone or no longer visible —
    // prune it (durable exclude).
    const present = new Set(rows.map((r: any) => String(r._id)));
    const missing = upsertIds.filter((id) => !present.has(id));
    if (missing.length) store.pruneFeedEntities(coll, missing);
  }
}

async function catchUp(convex: any): Promise<void> {
  const store = useInboxStore.getState();
  const meta = store.syncMeta[CHANGE_FEED_META_KEY];
  if (!meta?.cursor) {
    // Bootstrap: the per-table completeness crawls fill a cold cache; the feed
    // only carries changes from now forward. Stamp the cursor and return.
    store.recordSyncMeta(CHANGE_FEED_META_KEY, { cursor: Date.now() });
    return;
  }
  let since = Math.max(0, meta.cursor - OVERLAP_MS);
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    // `_probe` forces a real round-trip past any stalled subscription cache.
    const res: any = await convex.query(api.changeFeed.getChangesSince, {
      since,
      limit: FEED_LIMIT,
      _probe: Date.now(),
    });
    if (!res) break;
    if (res.changes?.length) await applyPage(convex, res.changes);
    if (typeof res.nextSince === "number") {
      useInboxStore.getState().recordSyncMeta(CHANGE_FEED_META_KEY, { cursor: res.nextSince });
      since = res.nextSince;
    }
    if (!res.hasMore) break;
  }
}

export function useSyncChangeFeed(): void {
  const convex = useConvex();
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const runningRef = useRef(false);

  const run = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    catchUp(convex)
      .catch((e) => console.warn("[changeFeed] catch-up failed", e))
      .finally(() => {
        runningRef.current = false;
      });
  }, [convex]);

  // eslint-disable-next-line no-restricted-syntax -- self-managed wake/interval catch-up
  useEffect(() => {
    if (!hydrated) return;
    run();
    const id = setInterval(run, FEED_TICK_MS);
    // Wake events are the primary trigger — a backgrounded/frozen tab catches up
    // the moment the user returns. `document` is web-only (this also runs in Expo,
    // where AppState drives the lifecycle).
    const doc = typeof document !== "undefined" ? document : undefined;
    const win = typeof window !== "undefined" ? window : undefined;
    const onVisible = () => {
      if (doc?.visibilityState === "visible") run();
    };
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("focus", run);
    win?.addEventListener?.("online", run);
    return () => {
      clearInterval(id);
      doc?.removeEventListener?.("visibilitychange", onVisible);
      win?.removeEventListener?.("focus", run);
      win?.removeEventListener?.("online", run);
    };
  }, [hydrated, run]);
}
