import { useCallback, useEffect, useRef } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, syncLogScopeMetaKey } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { onSyncWake } from "./syncWake";
import { beginSyncInflight } from "../store/syncActivity";

// Sync-log client applier — the single catch-up path.
// Design: docs/architecture/sync-log-migration.md (pl-399, D7).
//
// The server keeps an append-only, per-scope action log with gap-free positions
// (convex/syncLog.ts). This hook holds one persisted cursor per scope
// (`synclog:v1:<scope_key>` in syncMeta) and, on every wake signal, replays
// (cursor, head] through the existing stage-two byIds queries into syncTable.
// Deletion truth is authorized absence: EVERY changed id — upsert or delete —
// is fetched through the authorized byIds query, and only ids the query omits
// are pruned (a scope-move revocation delete can therefore never remove a row
// the viewer still holds through another scope).
//
// Wake signals: a tiny getHeads live subscription (re-runs on semantic writes
// only — the interceptor's churn exemption keeps message-flush bumps out),
// debounced; plus visibility/focus/online and a slow interval, none of which
// are correctness dependencies — the cursor makes catch-up exact whenever it
// runs. The old Date.now()+overlap change feed survives in two roles here: a
// one-time upgrade BRIDGE (a warm cache drains getChangesSince from its legacy
// cursor, carrying the hard deletes of the away window, then the cursor is
// dropped once the log cursors are stamped) and the dev-only directional
// shadow comparator (localStorage SYNCLOG_SHADOW=1) that asserts the log path
// is a superset of the legacy feed.

const api = _api as any;

type Collection =
  | "sessions"
  | "tasks"
  | "docs"
  | "plans"
  | "projects";

const ENTITY_COLLECTION: Record<string, Collection> = {
  conversations: "sessions",
  tasks: "tasks",
  docs: "docs",
  plans: "plans",
  projects: "projects",
};

const COLLECTIONS: Collection[] = [
  "sessions",
  "tasks",
  "docs",
  "plans",
  "projects",
];

// Legacy change-feed cursor — read once by the upgrade bridge, then dropped.
const LEGACY_META_KEY = "changefeed:v1";
const LEGACY_OVERLAP_MS = 10_000;
const LEGACY_FEED_LIMIT = 1000;
const LEGACY_MAX_PAGES = 50;

// Single definition lives in the store (stampSyncAck's immediate-retire branch
// reads the same key); re-exported here for the applier's tests.
export const scopeMetaKey = syncLogScopeMetaKey;

const RANGE_LIMIT = 500;
const MAX_RANGE_PAGES = 50;
// Head-movement debounce: positions are cumulative, so batching bursts loses
// nothing; it just turns a fan-out's write burst into one catch-up cycle.
const HEADS_DEBOUNCE_MS = 1500;
// Safety-net interval; the subscription + wake events are the real triggers.
const TICK_MS = 60_000;

export type FeedChange = { entity_type: string; entity_id: string };

export function emptyIdsByCollection(): Record<Collection, string[]> {
  return { sessions: [], tasks: [], docs: [], plans: [], projects: [] };
}

// Pure: collapse change events into per-collection deduped id lists — the
// applyEntityIds input. The op is deliberately ignored: deletion truth is
// authorized absence (the byIds fetch omitting the id), never the event's op,
// so upserts and deletes take the same path. Used by both the log applier and
// the legacy bridge; unit-tested.
export function planFeedApply(changes: FeedChange[]): Record<Collection, string[]> {
  const plan = emptyIdsByCollection();
  const seen = new Set<string>();
  for (const c of changes) {
    const coll = ENTITY_COLLECTION[c.entity_type];
    if (!coll) continue;
    const key = `${coll}:${c.entity_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plan[coll].push(c.entity_id);
  }
  return plan;
}

// Every server-side *byIds query hard-caps its input at 300 ids (they
// `ids.slice(0, 300)`). Fetch in ≤300-id chunks so ids past the cap are never
// silently un-fetched — an un-returned id is treated as "gone or no longer
// visible" and would be pruned.
export const BYIDS_CHUNK = 300;

export function chunkIds(ids: string[], size: number = BYIDS_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

async function batchGetChunk(convex: any, coll: Collection, ids: string[]): Promise<any[]> {
  switch (coll) {
    case "sessions":
      return (await convex.query(api.conversations.getInboxSessionsByIds, { ids }))?.sessions ?? [];
    case "tasks":
      return (await convex.query(api.tasks.webGetByIds, { ids }))?.items ?? [];
    case "docs":
      return (await convex.query(api.docs.webGetByIds, { ids }))?.docs ?? [];
    case "plans":
      return (await convex.query(api.plans.webGetByIds, { ids })) ?? [];
    case "projects":
      return (await convex.query(api.projects.webGetByIds, { ids })) ?? [];
  }
}

// Per-collection batch fetch of CURRENT state for a set of ids. Each returns rows
// in the exact shape its live channel syncs, so syncTable merges them cleanly.
async function batchGet(convex: any, coll: Collection, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const rows: any[] = [];
  for (const chunk of chunkIds(ids)) {
    rows.push(...(await batchGetChunk(convex, coll, chunk)));
  }
  return rows;
}

// Stage two: fetch current state for a set of per-collection ids, overlay what
// the authorized query returned, prune what it omitted. Shared by the log
// applier and the legacy bridge; apply is idempotent.
async function applyEntityIds(
  convex: any,
  idsByCollection: Record<Collection, string[]>,
): Promise<Set<string>> {
  const applied = new Set<string>();
  const store = useInboxStore.getState();
  for (const coll of COLLECTIONS) {
    const ids = idsByCollection[coll];
    if (!ids?.length) continue;
    // Lift any prior exclude so a re-shared / restored entity isn't skipped by
    // the delta merge, THEN overlay current state.
    store.clearFeedExcludes(coll, ids);
    const rows = await batchGet(convex, coll, ids);
    if (rows.length) store.syncTable(coll, rows as any, { isDelta: true } as any);
    const present = new Set(rows.map((r: any) => String(r._id)));
    for (const id of ids) {
      if (present.has(id)) applied.add(`${coll}:${id}`);
    }
    noteShadowApplied(ids.map((id) => `${coll}:${id}`));
    // An id the authorized query did NOT return is gone or no longer visible —
    // prune it (durable exclude). This is the ONLY deletion path: a log
    // `delete` action never prunes by itself (it is scope-local).
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length) store.pruneFeedEntities(coll, missing);
  }
  return applied;
}

type LogAction = { position: number; entity_type: string; entity_id: string; op: string };

// Apply one scope's range page: scope lifecycle first, then acked-pending
// retirement (BEFORE the overlay, so authoritative post-write rows land
// unblocked), then stage two, then the cursor advance. `purgedTeams` collects
// team ids revoked in this page so the caller's heads loop can skip their
// (stale) heads instead of restamping a cursor the purge just dropped.
async function applyLogPage(
  convex: any,
  scopeKey: string,
  actions: LogAction[],
  upTo: number,
  purgedTeams: Set<string>,
): Promise<void> {
  const store = useInboxStore.getState();
  const entityActions: FeedChange[] = [];
  for (const a of actions) {
    if (a.entity_type === "scope") {
      if (a.op === "scope_removed") {
        store.purgeTeamScopeRows(a.entity_id);
        store.clearSyncMeta(scopeMetaKey(`team:${a.entity_id}`));
        purgedTeams.add(a.entity_id);
      } else if (a.op === "scope_added") {
        // Cold-start the new team scope: its cursor stamps on the next heads
        // pass, and clearing the workspace backfill marks (ALL wsArgs variants
        // for the scope) makes the crawls run a full backfill when the
        // workspace becomes active. Rejoin also lifts the revocation purge's
        // excludes — without this, rows purged on scope_removed would be
        // dropped by every delta merge after rejoining.
        store.clearCrawlMetaForScope(`team:${a.entity_id}`);
        purgedTeams.delete(a.entity_id);
      }
      continue;
    }
    entityActions.push(a);
  }
  store.retireAckedPending(scopeKey, upTo);
  await applyEntityIds(convex, planFeedApply(entityActions));
  store.recordSyncMeta(scopeMetaKey(scopeKey), { cursor: upTo });
}

// Catch one scope up to its head. Cold scope: stamp the cursor at the head we
// were handed — the past is owned by the snapshot floors and cold backfill
// (design D9), the future by the log from this position. Resync (retention
// passed the cursor): drop the cursor and every crawl watermark the scope
// owns, so the next crawl is a FULL backfill, then restamp at head.
export async function catchUpScope(
  convex: any,
  head: { scope_key: string; position: number; floor: number },
  purgedTeams: Set<string>,
): Promise<void> {
  const store = useInboxStore.getState();
  const metaKey = scopeMetaKey(head.scope_key);
  const meta = store.syncMeta[metaKey];

  const resetForResync = () => {
    const s = useInboxStore.getState();
    s.clearSyncMeta(metaKey);
    s.clearCrawlMetaForScope(head.scope_key);
    s.recordSyncMeta(metaKey, { cursor: head.position });
  };

  if (meta?.cursor === undefined) {
    store.recordSyncMeta(metaKey, { cursor: head.position });
    return;
  }
  if (head.floor > meta.cursor) {
    // Retention passed our cursor while we were away: the log can no longer
    // prove the gap, so fall back to the cold-backfill contract.
    resetForResync();
    return;
  }
  let from = meta.cursor;
  for (let page = 0; page < MAX_RANGE_PAGES && from < head.position; page++) {
    const res: any = await convex.query(api.syncLog.getRange, {
      scope_key: head.scope_key,
      from,
      limit: RANGE_LIMIT,
    });
    if (!res) return;
    if (res.authorized === false) {
      // Membership revoked and we raced the scope_removed action (or it was
      // already retention-pruned): treat as scope drop, not a retryable error.
      if (head.scope_key.startsWith("team:")) {
        const teamId = head.scope_key.slice(5);
        store.purgeTeamScopeRows(teamId);
        store.clearSyncMeta(metaKey);
        purgedTeams.add(teamId);
      }
      return;
    }
    if (res.resync) {
      resetForResync();
      return;
    }
    if (res.actions?.length) {
      await applyLogPage(convex, head.scope_key, res.actions, res.nextFrom, purgedTeams);
    } else if (typeof res.nextFrom === "number" && res.nextFrom > from) {
      useInboxStore.getState().recordSyncMeta(scopeMetaKey(head.scope_key), { cursor: res.nextFrom });
    } else if (!res.hasMore) {
      // Empty range below a moving head (coalescing moved rows past us):
      // nothing left to apply — the head subscription will wake us again.
      return;
    }
    from = Math.max(from, typeof res.nextFrom === "number" ? res.nextFrom : from);
    if (!res.hasMore) return;
  }
}

// One-time upgrade bridge: drain the legacy getChangesSince feed from its
// persisted cursor, so hard deletes and kills from the away window reach a warm
// cache exactly once. Returns whether the drain COMPLETED (no legacy cursor, or
// reached !hasMore). The caller — never this function — drops the legacy
// cursor, and only after the scope cursors are stamped: clearing here would
// leave a crash window (tab closes between clear and stamp) where the next run
// has neither cursor and cold-stamps past the away window's deletes. An
// incomplete drain (failed query, page cap) keeps the advanced cursor and
// resumes next run. The legacy query stays deployed for old bundles regardless.
async function drainLegacyBridge(convex: any): Promise<boolean> {
  const store = useInboxStore.getState();
  const legacy = store.syncMeta[LEGACY_META_KEY];
  if (!legacy?.cursor) return true;
  let since = Math.max(0, legacy.cursor - LEGACY_OVERLAP_MS);
  for (let page = 0; page < LEGACY_MAX_PAGES; page++) {
    const res: any = await convex.query(api.changeFeed.getChangesSince, {
      since,
      limit: LEGACY_FEED_LIMIT,
      _probe: Date.now(),
    });
    if (!res) return false; // retry next run from the checkpointed cursor
    if (res.changes?.length) {
      await applyEntityIds(convex, planFeedApply(res.changes));
    }
    if (typeof res.nextSince === "number" && res.nextSince > since) {
      useInboxStore.getState().recordSyncMeta(LEGACY_META_KEY, { cursor: res.nextSince });
      since = res.nextSince;
    }
    if (!res.hasMore) return true;
  }
  return false; // page cap hit with more remaining — resume next run
}

async function catchUp(convex: any): Promise<void> {
  const runStart = Date.now();
  const store = useInboxStore.getState();
  // Heads FIRST, bridge second: the bridge then drains to "now", past every
  // captured head, so a cold cursor stamped at a captured head leaves no window
  // between the drained watermark and the stamp (review C10). Writes after the
  // capture have higher positions and are replayed by the log next run.
  const res: any = await convex.query(api.syncLog.getHeads, {});
  if (!res) return;
  const heads: Array<{ scope_key: string; position: number; floor: number }> = res.heads ?? [];
  const hadLegacy = !!store.syncMeta[LEGACY_META_KEY]?.cursor;
  const drainComplete = await drainLegacyBridge(convex);
  // Sequential by design: one serialized apply pipeline (design D7), so a stale
  // stage-two fetch can never land after a fresher one. `purgedTeams` fences a
  // scope revoked mid-run — its stale head must not restamp the cursor the
  // purge just dropped.
  const purgedTeams = new Set<string>();
  // Publish how far behind each scope is BEFORE replaying, so the header pill
  // can show a real catch-up (cursor < head) and nothing else on a warm cache.
  // A cold scope (no cursor) stamps at head and is therefore never "behind".
  for (const head of heads) {
    const cursor = store.syncMeta[scopeMetaKey(head.scope_key)]?.cursor;
    store.setSyncLogLag(head.scope_key, cursor === undefined ? 0 : Math.max(0, head.position - cursor));
  }
  try {
    for (const head of heads) {
      if (head.scope_key.startsWith("team:") && purgedTeams.has(head.scope_key.slice(5))) continue;
      await catchUpScope(convex, head, purgedTeams);
      useInboxStore.getState().setSyncLogLag(head.scope_key, 0);
    }
  } finally {
    // A failed run must not leave the pill lit forever; the next wake retries.
    const s = useInboxStore.getState();
    for (const head of heads) s.setSyncLogLag(head.scope_key, 0);
  }
  // Heads-absence sweep (design D5 backstop): a persisted team cursor whose
  // scope getHeads no longer lists is a revoked membership whose scope_removed
  // action we never saw (e.g. retention-pruned while this client was away).
  // getHeads always lists every CURRENT membership, so absence is revocation.
  // Guarded on a non-empty heads response — an auth blip returns {heads: []}
  // and must not purge everything.
  if (heads.length > 0) {
    const present = new Set(heads.map((h) => h.scope_key));
    const s2 = useInboxStore.getState();
    for (const key of Object.keys(s2.syncMeta)) {
      if (!key.startsWith("synclog:v1:team:")) continue;
      const scopeKey = key.slice("synclog:v1:".length);
      if (present.has(scopeKey)) continue;
      const teamId = scopeKey.slice(5);
      s2.purgeTeamScopeRows(teamId);
      s2.clearSyncMeta(key);
      s2.clearCrawlMetaForScope(scopeKey);
    }
  }
  // The legacy cursor may be dropped only once BOTH are true: the drain
  // reached the end, and every scope cursor for this run is stamped (the loop
  // above). Until then the checkpointed legacy cursor is the recovery path.
  if (hadLegacy && drainComplete) {
    useInboxStore.getState().clearSyncMeta(LEGACY_META_KEY);
  }
  await shadowCompare(convex, runStart);
}

// Directional shadow comparator (design D11, dev only): assert the log path is a
// SUPERSET of the legacy feed over the same window — an id the old feed reports
// that the log path neither applied this run nor already holds is a log gap.
// Conversations are whitelisted (the churn exemption makes their counter-only
// divergence expected). Flag-gated; old-feed noise cannot mask log gaps because
// the check only fires one way.
let shadowApplied: Set<string> | null = null;
function noteShadowApplied(keys: Iterable<string>): void {
  if (shadowApplied) for (const k of keys) shadowApplied.add(k);
}
function shadowEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("SYNCLOG_SHADOW") === "1";
  } catch {
    return false;
  }
}
async function shadowCompare(convex: any, runStart: number): Promise<void> {
  if (!shadowEnabled()) {
    shadowApplied = null;
    return;
  }
  const applied = shadowApplied ?? new Set<string>();
  shadowApplied = new Set(); // window resets each run
  try {
    const res: any = await convex.query(api.changeFeed.getChangesSince, {
      since: runStart - 60_000,
      limit: 1000,
      _probe: Date.now(),
    });
    const store = useInboxStore.getState() as any;
    const gaps: string[] = [];
    for (const c of res?.changes ?? []) {
      if (c.entity_type === "conversations") continue; // churn-exempt by design
      const coll = ENTITY_COLLECTION[c.entity_type];
      if (!coll) continue;
      const key = `${coll}:${c.entity_id}`;
      const held = store[coll]?.[c.entity_id] !== undefined;
      if (!applied.has(key) && (c.op === "upsert") === !held) gaps.push(`${c.op} ${key}`);
    }
    if (gaps.length) console.warn("[synclog:shadow] legacy feed ids the log path lacks:", gaps);
    else console.info("[synclog:shadow] superset check clean");
  } catch {
    // comparator is best-effort; never let it affect the applier
  }
}

export function useSyncChangeFeed(): void {
  const convex = useConvex();
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(() => {
    if (runningRef.current) {
      // A wake arrived mid-run (e.g. our own catch-up's writes bumped a head).
      // Queue exactly one follow-up so nothing is dropped.
      rerunRef.current = true;
      return;
    }
    runningRef.current = true;
    // The digest compare's quiescence gate: a range replay is in flight.
    const release = beginSyncInflight("range");
    catchUp(convex)
      .catch((e) => console.warn("[syncLog] catch-up failed", e))
      .finally(() => {
        release();
        runningRef.current = false;
        if (rerunRef.current) {
          rerunRef.current = false;
          run();
        }
      });
  }, [convex]);

  const scheduleRun = useCallback(() => {
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      run();
    }, HEADS_DEBOUNCE_MS);
  }, [run]);

  // The wake signal: a tiny heads subscription. Payload is per-scope positions
  // only; the churn exemption keeps its invalidation rate at semantic-write
  // rate. Never a correctness dependency — any run replays exactly from the
  // persisted cursors.
  const { data: headsData } = useQueryNoThrow(api.syncLog.getHeads, hydrated ? {} : "skip");

  // eslint-disable-next-line no-restricted-syntax -- self-managed wake/interval catch-up
  useEffect(() => {
    if (!hydrated || headsData === undefined) return;
    scheduleRun();
  }, [hydrated, headsData, scheduleRun]);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!hydrated) return;
    run();
    const id = setInterval(run, TICK_MS);
    // Wake events — a backgrounded/frozen client catches up the moment the
    // user returns. `document` is web-only; the syncWake bus below is the
    // platform-neutral source (AppState "active" on mobile, wired by
    // StoreSyncBridge), so an iOS resume replays the cursors too.
    const doc = typeof document !== "undefined" ? document : undefined;
    const win = typeof window !== "undefined" ? window : undefined;
    const onVisible = () => {
      if (doc?.visibilityState === "visible") run();
    };
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("focus", run);
    win?.addEventListener?.("online", run);
    const offWake = onSyncWake(run);
    return () => {
      clearInterval(id);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      offWake();
      doc?.removeEventListener?.("visibilitychange", onVisible);
      win?.removeEventListener?.("focus", run);
      win?.removeEventListener?.("online", run);
    };
  }, [hydrated, run]);
}
