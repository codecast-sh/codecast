import Dexie from "dexie";
import type { Patch } from "mutative";
import {
  COLLECTION_STORE_KEYS,
  META_STORE_KEYS,
  collectionRowValidator,
  isPersistedClientStoreKey,
} from "./clientSyncRegistry";
import { diffCollection } from "./idbCollectionDiff";

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

export async function loadCache(): Promise<Record<string, any> | null> {
  try {
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionEntries = Object.entries(COLLECTION_TABLES);
    const [collectionResults, metaRows] = await Promise.all([
      Promise.all(collectionEntries.map(([, table]) => table.toArray())),
      db.meta.toArray(),
    ]);

    collectionEntries.forEach(([key, table], i) => {
      const rows = collectionResults[i];
      // Seed the persistence shadow with what's on disk (even an empty table) so
      // the first write after hydrate diffs against reality and can prune rows
      // the server has since deleted.
      const shadow = new Map<string, any>();
      const validRow = collectionRowValidator(key);
      // Foreign documents persisted under the wrong collection (see validRow in
      // the registry) are excluded from hydration AND removed from disk, so the
      // cache self-heals instead of resurrecting phantoms on every load.
      const invalid: string[] = [];
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
