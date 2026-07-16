import Dexie from "dexie";
import type { Patch } from "mutative";
import {
  COLLECTION_STORE_KEYS,
  META_STORE_KEYS,
  collectionRowValidator,
  isPersistedClientStoreKey,
} from "./clientSyncRegistry";
import { diffCollection } from "./idbCollectionDiff";
import { isConvexId } from "../lib/entityLinks";

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
  // Failed boot replays so far; entries are given up on at
  // MAX_OUTBOX_BOOT_ATTEMPTS (see mutativeMiddleware).
  attempts?: number;
};

export const PERSISTENCE_AVAILABLE = typeof window !== "undefined";

class CacheDB extends Dexie {
  sessions!: Dexie.Table<any, string>;
  tasks!: Dexie.Table<any, string>;
  docs!: Dexie.Table<any, string>;
  plans!: Dexie.Table<any, string>;
  projects!: Dexie.Table<any, string>;
  buckets!: Dexie.Table<any, string>;
  bucketAssignments!: Dexie.Table<any, string>;
  comments!: Dexie.Table<any, string>;
  meta!: Dexie.Table<{ key: string; value: any }, string>;
  conversationMessages!: Dexie.Table<{ convId: string; messages: any[]; latestTimestamp: number; pagination: any }, string>;
  dispatchOutbox!: Dexie.Table<OutboxEntry, string>;

  constructor() {
    super("codecast-store");
    this.version(1).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      meta: "key",
    });
    this.version(2).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      meta: "key",
      conversationMessages: "convId",
    });
    this.version(3).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      meta: "key",
      conversationMessages: "convId",
    });
    this.version(4).stores({
      sessions: "_id",
      dismissedSessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      meta: "key",
      conversationMessages: "convId",
      dispatchOutbox: "id, ts",
    });
    // v5: dismissedSessions table dropped — dismissal is now a field on sessions.
    this.version(5).stores({
      sessions: "_id",
      dismissedSessions: null,
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      meta: "key",
      conversationMessages: "convId",
      dispatchOutbox: "id, ts",
    });
    // v6: manual session buckets + per-conversation assignments.
    this.version(6).stores({
      sessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      buckets: "_id",
      bucketAssignments: "_id",
      meta: "key",
      conversationMessages: "convId",
      dispatchOutbox: "id, ts",
    });
    // v7: teammate comments collection.
    this.version(7).stores({
      sessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      buckets: "_id",
      bucketAssignments: "_id",
      comments: "_id",
      meta: "key",
      conversationMessages: "convId",
      dispatchOutbox: "id, ts",
    });
    // v8: index conversationMessages by latestTimestamp so the on-disk store can
    // be pruned (LRU + TTL) instead of growing forever — one row per conversation
    // ever opened, each up to several MB of inline-image message bodies.
    this.version(8).stores({
      sessions: "_id",
      tasks: "_id",
      docs: "_id",
      plans: "_id",
      projects: "_id",
      buckets: "_id",
      bucketAssignments: "_id",
      comments: "_id",
      meta: "key",
      conversationMessages: "convId, latestTimestamp",
      dispatchOutbox: "id, ts",
    });
  }
}

const db = new CacheDB();

const COLLECTION_TABLES: Record<string, Dexie.Table<any, string>> = Object.fromEntries(
  COLLECTION_STORE_KEYS.filter((key) => (db as any)[key]).map((key) => [key, db[key]])
);

// A registered collection with no Dexie table (schema version not bumped) would
// reject loadCache's Promise.all and silently disable the ENTIRE cache. Degrade
// to skipping just that key, and surface the gap loudly — the registry coverage
// test asserts this list is empty.
export const MISSING_COLLECTION_TABLES: string[] = COLLECTION_STORE_KEYS.filter(
  (key) => !(db as any)[key]
);
if (MISSING_COLLECTION_TABLES.length > 0) {
  console.error(
    `[idbCache] registry collections missing Dexie tables: ${MISSING_COLLECTION_TABLES.join(", ")} — add a CacheDB schema version`
  );
}

const META_KEYS = new Set<string>(META_STORE_KEYS);

let _hydrating = false;

// What each collection table currently holds on disk, by id → row reference.
// Lets writePatchesToIDB persist only the rows that actually changed (and delete
// the ones that disappeared) instead of clearing + re-pouring the whole table.
// Seeded from loadCache so the first post-hydrate write diffs against disk, not
// an empty set (which would leave pruned rows stranded as ghosts).
const lastPersisted = new Map<string, Map<string, any>>();

// Test hook: the shadow lives at module scope and would otherwise leak across
// tests that reset the underlying storage out from under it.
export function _resetPersistedShadow() {
  lastPersisted.clear();
}

// A top-level store key is durable iff it maps to a dedicated collection table
// or is whitelisted as a meta blob. Keys that satisfy neither are silently
// dropped on write — the class of bug that lost pending user messages.
export function isPersistedStoreKey(key: string): boolean {
  return isPersistedClientStoreKey(key);
}

export function writePatchesToIDB(patches: Patch[], state: any) {
  if (_hydrating) return;

  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  for (const key of affectedKeys) {
    const table = COLLECTION_TABLES[key];
    if (table) {
      const data = state[key];
      if (data && typeof data === "object") {
        const prevShadow = lastPersisted.get(key);
        const { puts, deletes: rawDeletes, next } = diffCollection(prevShadow, data);
        // NEVER wipe the cache from a store-shrink. A row leaves IDB ONLY when it
        // was explicitly removed — kill/archive plant a `${key}:${id}` exclude in
        // `pending`. A diff-delete with NO exclude means the in-memory store is
        // merely MISSING the row (a paused hydration, a windowed live payload, a
        // bug), so keep it on disk AND in the shadow. Read-time filters hide stale
        // rows; the durable cache is never destroyed. This makes a whole-collection
        // wipe structurally impossible — only intentional per-row removals delete.
        const pending = (state.pending || {}) as Record<string, { type?: string }>;
        const deletes: string[] = [];
        for (const id of rawDeletes) {
          if (pending[`${key}:${id}`]?.type === "exclude") deletes.push(id);
          else if (prevShadow?.has(id)) next.set(id, prevShadow.get(id));
        }
        lastPersisted.set(key, next);
        if (puts.length || deletes.length) {
          // One transaction so a row is never momentarily absent: removed rows
          // and changed rows commit together, and unchanged rows are never
          // touched. Replaces the old clear()+bulkPut full-table rewrite.
          db.transaction("rw", table, async () => {
            if (deletes.length) await table.bulkDelete(deletes);
            if (puts.length) await table.bulkPut(puts);
          }).catch(() => {});
        }
      }
    } else if (META_KEYS.has(key)) {
      db.meta.put({ key, value: state[key] }).catch(() => {});
    }
  }
}

// Retention for the persisted sessions collection, applied at hydration. The
// in-memory sessions map is never-prune BY DESIGN (rows the UI holds must not
// vanish mid-session), which means the on-disk cache is append-only across
// months: every team-board visit, deep link, and crawl top-up leaves a row
// forever. A long-lived install was measured hydrating ~7,000 rows (5k+ older
// than 30 days, 4k belonging to teammates) into a map whose live inbox renders
// ~134 — and every O(N) pass (syncTable, wake signatures, categorizeSessions,
// sortSessions) paid the 7k price on each liveness flip, pinning the main
// thread. Boot is the one safe moment to shed that weight: nothing holds refs
// yet, and everything the UI can actually reach is kept —
//   • the server-authoritative live inbox set (liveInboxIdList),
//   • the restored focus target,
//   • optimistic stubs (non-Convex ids — local truths the server can't restore),
//   • pinned rows (an explicit keep),
//   • stashed/dismissed rows inside the reconcile window (the Stashed/Killed
//     browse views),
//   • anything touched inside the TTL, capped at the newest MAX_CACHED_SESSIONS.
// Anything older is dropped from memory AND disk; it stays reachable via
// search/deep-link, which re-fetch from the server and re-seed the cache.
const SESSION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // mirrors DISMISS_RECONCILE_WINDOW_MS / the server crawl window
const MAX_CACHED_SESSIONS = 1200;

export function partitionSessionRetention(
  rows: any[],
  liveInboxIdList: string[] | undefined,
  lastFocusedId: string | null | undefined,
  now: number,
): { keep: any[]; drop: string[] } {
  const liveIds = new Set(liveInboxIdList ?? []);
  const pinnedKeep: any[] = [];
  const windowed: any[] = [];
  const drop: string[] = [];
  for (const row of rows) {
    const stampedAt = Math.max(row.updated_at ?? 0, row._creationTime ?? 0, row.inbox_stashed_at ?? 0, row.inbox_dismissed_at ?? 0);
    if (liveIds.has(row._id) || row._id === lastFocusedId || !isConvexId(row._id) || row.is_pinned) {
      pinnedKeep.push(row);
    } else if (now - stampedAt <= SESSION_CACHE_TTL_MS) {
      windowed.push(row);
    } else {
      drop.push(row._id);
    }
  }
  // Cap the TTL-window survivors (never the always-keep set), newest first.
  if (windowed.length > MAX_CACHED_SESSIONS) {
    windowed.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    for (const row of windowed.splice(MAX_CACHED_SESSIONS)) drop.push(row._id);
  }
  return { keep: pinnedKeep.concat(windowed), drop };
}

// Exclude tombstones never clear for delta tables (absence ≠ deletion in
// applySyncTable), so every kill/dismiss adds a permanent `pending` entry —
// measured at 1,832 entries after a heavy agent fan-out, and each one rides
// every sync push and every persisted pending blob. A tombstone only matters
// while the server could still resend the row, which is bounded by the same
// 30d window as the cache retention above — age them out at hydration. Legacy
// entries without a timestamp get stamped `now` and age out one window later.
// include/field entries are local-first writes awaiting server acknowledgment:
// never expired.
export function expireExcludeTombstones(
  pending: Record<string, any>,
  now: number,
): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, entry] of Object.entries(pending)) {
    if (entry?.type === "exclude") {
      if (!entry.ts) { cleaned[key] = { ...entry, ts: now }; continue; }
      if (now - entry.ts > SESSION_CACHE_TTL_MS) continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}

export async function loadCache(): Promise<Record<string, any> | null> {
  try {
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionEntries = Object.entries(COLLECTION_TABLES);
    const [collectionResults, metaRows] = await Promise.all([
      Promise.all(collectionEntries.map(([, table]) => table.toArray())),
      db.meta.toArray(),
    ]);

    // Meta lookup first — the sessions retention pass below needs
    // liveInboxIdList and lastFocusedConversationId from the same snapshot.
    const metaByKey: Record<string, any> = {};
    for (const row of metaRows) metaByKey[row.key] = row.value;

    collectionEntries.forEach(([key, table], i) => {
      let rows = collectionResults[i];
      // Seed the persistence shadow with what's on disk (even an empty table) so
      // the first write after hydrate diffs against reality and can prune rows
      // the server has since deleted.
      const shadow = new Map<string, any>();
      const validRow = collectionRowValidator(key);
      // Foreign documents persisted under the wrong collection (see validRow in
      // the registry) are excluded from hydration AND removed from disk, so the
      // cache self-heals instead of resurrecting phantoms on every load.
      const invalid: string[] = [];
      if (key === "sessions" && rows.length > 0) {
        const { keep, drop } = partitionSessionRetention(
          rows,
          metaByKey.liveInboxIdList,
          metaByKey.lastFocusedConversationId,
          Date.now(),
        );
        rows = keep;
        if (drop.length) table.bulkDelete(drop).catch(() => {});
      }
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) {
          if (validRow && !validRow(row)) { invalid.push(row._id); continue; }
          map[row._id] = row; shadow.set(row._id, row);
        }
        if (Object.keys(map).length > 0) {
          result[key] = map;
          hasData = true;
        }
      }
      if (invalid.length) table.bulkDelete(invalid).catch(() => {});
      lastPersisted.set(key, shadow);
    });

    for (const row of metaRows) {
      result[row.key] = row.value;
      hasData = true;
    }

    // The conversations map is the sessions cache's twin (same ids, richer
    // metadata) persisted as ONE meta blob — every put structured-clones the
    // whole thing on the main thread, so an unpruned blob (measured at ~2,700
    // entries) costs hundreds of ms per write and at boot. Apply the same
    // retention policy; the pruned blob reaches disk on its next natural put.
    if (result.conversations && typeof result.conversations === "object") {
      const { keep } = partitionSessionRetention(
        Object.values(result.conversations),
        metaByKey.liveInboxIdList,
        metaByKey.lastFocusedConversationId,
        Date.now(),
      );
      const pruned: Record<string, any> = {};
      for (const row of keep) pruned[row._id] = row;
      result.conversations = pruned;
    }

    if (result.pending && typeof result.pending === "object") {
      result.pending = expireExcludeTombstones(result.pending, Date.now());
    }

    return hasData ? result : null;
  } catch {
    return null;
  }
}

export function setHydrating(v: boolean) {
  _hydrating = v;
}

// -- Per-conversation message cache --

// IDB writes are coalesced per conversation. setMessages fires on nearly every
// live-sync tick for the focused conversation, and each write serializes the
// ENTIRE conversation — message bodies carry inline images, so a single put can
// be multiple MB. Writing the whole thing on every appended message is pure
// waste: this row is a reload cache, not the live source of truth (the in-memory
// store is, and it still updates synchronously). We keep only the latest payload
// per conv and flush on a short trailing timer, collapsing a burst of N ticks
// into one write. The timer is scheduled once per burst (not reset on each
// write), so a continuous stream still flushes at most every DEBOUNCE_MS rather
// than starving. Reads consult the pending buffer first for read-your-writes,
// and page-hide flushes so an abrupt close still persists the freshest state.
const _pendingMsgWrites = new Map<string, { messages: any[]; pagination: any }>();
let _msgWriteTimer: ReturnType<typeof setTimeout> | null = null;
const MSG_WRITE_DEBOUNCE_MS = 300;

// On-disk prune of the conversationMessages store. Every conversation ever opened
// leaves a row (up to several MB with inline images) and nothing ever deleted it,
// so the store climbed unbounded (~445MB in a past incident). We cap it at the N
// most-recently-active conversations and drop anything past a TTL, ordered by the
// latestTimestamp index. Runs lazily off the write path — piggybacked on the
// debounced flush and throttled — never on the hot per-tick path.
const MAX_CACHED_CONVERSATIONS = 300;
const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PRUNE_THROTTLE_MS = 5 * 60 * 1000; // at most once per 5 min
const PROTECT_RECENT_MS = 10 * 60 * 1000; // never prune a conv touched this recently
// Wall-clock of the last write per conversation — a conversation open/on-screen is
// written continuously, so a recent touch marks it protected from pruning even if
// its newest message (its latestTimestamp) is old.
const _touchedAt = new Map<string, number>();
let _lastPruneAt = 0;

function _latestTs(messages: any[]): number {
  // Loop, not Math.max(...spread): spreading a long messages array risks a
  // call-stack overflow, and this now runs once per flush instead of per tick.
  let latest = 0;
  for (const m of messages) {
    const t = m?.timestamp || 0;
    if (t > latest) latest = t;
  }
  return latest;
}

function _flushMessageWrites() {
  if (_msgWriteTimer) {
    clearTimeout(_msgWriteTimer);
    _msgWriteTimer = null;
  }
  if (_pendingMsgWrites.size === 0) return;
  const batch = Array.from(_pendingMsgWrites.entries());
  _pendingMsgWrites.clear();
  for (const [convId, { messages, pagination }] of batch) {
    db.conversationMessages
      .put({ convId, messages, pagination, latestTimestamp: _latestTs(messages) })
      .catch(() => {});
  }
  _maybePruneConversations();
}

// Drop conversationMessages rows beyond the cap (oldest by latestTimestamp) and
// past the TTL, skipping any conversation currently buffered or recently touched
// (open/on-screen). Reads only primary keys off the latestTimestamp index, so the
// multi-MB message payloads are never loaded; best-effort and never throws.
async function _pruneConversations() {
  try {
    const now = Date.now();
    const protectedIds = new Set<string>(_pendingMsgWrites.keys());
    for (const [convId, ts] of _touchedAt) {
      if (now - ts <= PROTECT_RECENT_MS) protectedIds.add(convId);
      else _touchedAt.delete(convId); // let the recency map self-bound
    }

    // Ascending by latestTimestamp (oldest first); everything past the cap is the
    // least-recently-active tail. primaryKeys() reads the index only, not the rows.
    const orderedKeys = await db.conversationMessages.orderBy("latestTimestamp").primaryKeys();
    const overCap =
      orderedKeys.length > MAX_CACHED_CONVERSATIONS
        ? orderedKeys.slice(0, orderedKeys.length - MAX_CACHED_CONVERSATIONS)
        : [];
    const expired = await db.conversationMessages
      .where("latestTimestamp")
      .below(now - CONVERSATION_TTL_MS)
      .primaryKeys();

    const doomed = new Set<string>([...overCap, ...expired]);
    for (const id of protectedIds) doomed.delete(id);
    if (doomed.size > 0) await db.conversationMessages.bulkDelete([...doomed]);
  } catch {
    // Maintenance is best-effort — the durable cache tolerates skipped prunes.
  }
}

function _maybePruneConversations() {
  const now = Date.now();
  if (now - _lastPruneAt < PRUNE_THROTTLE_MS) return;
  _lastPruneAt = now;
  void _pruneConversations();
}

// Flush any buffered conversation writes immediately (e.g. on page hide).
export function flushConversationMessages() {
  _flushMessageWrites();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", _flushMessageWrites);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") _flushMessageWrites();
  });
}

export async function loadConversationMessages(convId: string): Promise<{ messages: any[]; pagination: any; latestTimestamp: number } | null> {
  // Read-your-writes: a just-written-but-not-yet-flushed payload is the freshest
  // truth, so serve it before falling back to the persisted IDB row.
  const pending = _pendingMsgWrites.get(convId);
  if (pending) {
    return { messages: pending.messages, pagination: pending.pagination, latestTimestamp: _latestTs(pending.messages) };
  }
  try {
    const row = await db.conversationMessages.get(convId);
    if (!row) return null;
    return { messages: row.messages, pagination: row.pagination, latestTimestamp: row.latestTimestamp };
  } catch {
    return null;
  }
}

export function writeConversationMessages(convId: string, messages: any[], pagination: any) {
  if (_hydrating) return;
  _touchedAt.set(convId, Date.now());
  _pendingMsgWrites.set(convId, { messages, pagination });
  if (!_msgWriteTimer) _msgWriteTimer = setTimeout(_flushMessageWrites, MSG_WRITE_DEBOUNCE_MS);
}

// -- Dispatch outbox: persist server-bound mutations until acknowledged --

export function enqueueDispatch(entry: OutboxEntry) {
  db.dispatchOutbox.put(entry).catch(() => {});
}

export function removeDispatch(id: string) {
  db.dispatchOutbox.delete(id).catch(() => {});
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    return await db.dispatchOutbox.orderBy("ts").toArray();
  } catch {
    return [];
  }
}
