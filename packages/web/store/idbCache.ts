import Dexie from "dexie";
import type { Patch } from "mutative";
import {
  COLLECTION_INDEXES,
  COLLECTION_STORE_KEYS,
  META_STORE_KEYS,
  collectionRowValidator,
  collectionRowHydrator,
  isPersistedClientStoreKey,
} from "./clientSyncRegistry";
import { diffCollection } from "./idbCollectionDiff";
import { partitionSessionRetention, partitionDocDetailRetention, expireExcludeTombstones } from "./cacheRetention";
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
  operationSchemaVersion?: number;
  // Repeated-write actions keep at most one row per key (see
  // OUTBOX_COALESCE_KEYS in mutativeMiddleware).
  coalesceKey?: string;
};

export const PERSISTENCE_AVAILABLE = typeof window !== "undefined";

// The on-disk schema is DERIVED from the client sync registry: every persisted
// collection becomes a table keyed by its registered `indexes` (default "_id"),
// beside the three system tables below. Registering a collection IS the schema
// change; the only hand step left is bumping CACHE_SCHEMA_VERSION so IndexedDB
// runs the upgrade (a test pins CACHE_SCHEMA_SIGNATURE to the derived schema,
// so a schema change without a bump fails at test time, not at a user's boot).
//
// One version declaration is enough for every installed DB: Dexie diffs the
// declared schema against what is actually on disk (adds tables and indexes,
// drops removed tables) rather than replaying a version ladder — so the old
// twelve-step ladder that restated the whole schema per step is gone.
export const CACHE_SCHEMA_VERSION = 28;
export const CACHE_SCHEMA_SIGNATURE =
  "agentTaskRuns:_id, task_id|agentTasks:_id|anchorSpaces:_id|anchors:_id|artifacts:_id|bucketAssignments:_id|buckets:_id|capabilityBindings:_id|capabilityState:_id|chatChannels:_id|chatMessages:_id, channel_id, thread_root_id|chatReactions:_id, message_id|chatReads:_id, channel_id|codeComments:_id, pull_request_id, repository, file_path, created_at|comments:_id|commits:_id|docDetails:_id|docs:_id|externalEvents:_id, team_id, conversation_id, pr_id, task_id, repository, created_at|issueSyncSources:_id, project_id|managedSessions:_id|messageFeed:_id, timestamp|pageThreads:_id|pendingPermissions:_id, conversation_id|plans:_id|projects:_id|pullRequests:_id|repoBrowse:_id, scope, repository|repoBrowseAccess:_id, scope, repository|savedViews:_id|sessionDecisions:_id|sessions:_id|settingsData:_id|tasks:_id|threadInbox:_id, kind, team_id, channel_id, conversation_id, task_id|workflowRuns:_id, workflow_id|workflows:_id";

const SYSTEM_TABLES = {
  meta: "key",
  // Indexed by latestTimestamp so the on-disk store can be pruned (LRU + TTL)
  // instead of growing forever — one row per conversation ever opened.
  conversationMessages: "convId, latestTimestamp",
  // The complete navigable user-message list (getUserMessages), one small row
  // per conversation. Its own table, not a field on conversationMessages: the
  // two lists arrive from different subscriptions at different times, and a
  // shared row would need a read-modify-write per flush to avoid one list
  // clobbering the other. Pruned in lockstep with conversationMessages.
  conversationUserMessages: "convId",
  dispatchOutbox: "id, ts",
} as const;

/** Stable serialization of the derived collection schema (sorted). */
export function cacheSchemaSignature(): string {
  return Object.keys(COLLECTION_INDEXES)
    .sort()
    .map((k) => `${k}:${COLLECTION_INDEXES[k]}`)
    .join("|");
}

class CacheDB extends Dexie {
  meta!: Dexie.Table<{ key: string; value: any }, string>;
  conversationMessages!: Dexie.Table<{ convId: string; messages: any[]; latestTimestamp: number; pagination: any }, string>;
  conversationUserMessages!: Dexie.Table<{ convId: string; userMessages: any[] }, string>;
  dispatchOutbox!: Dexie.Table<OutboxEntry, string>;

  constructor() {
    super("codecast-store");
    this.version(CACHE_SCHEMA_VERSION).stores({ ...COLLECTION_INDEXES, ...SYSTEM_TABLES });
  }
}

const db = new CacheDB();

// A schema upgrade needs every other Codecast tab on this origin to release
// its connection; a tab that is mid-hydration for a few seconds holds the
// upgrader, and every outbox write in THIS tab queues behind the blocked open
// ("durable enqueue still uncommitted"). Dexie's own warning reads as noise —
// name the cause so the fix (close/reload other tabs) is obvious.
if (PERSISTENCE_AVAILABLE) {
  db.on("blocked", (ev: any) => {
    console.warn(
      `[idbCache] codecast-store upgrade to schema v${CACHE_SCHEMA_VERSION} is blocked by another Codecast tab still on schema v${Math.ceil((ev?.oldVersion ?? 0) / 10)} — close or reload other tabs`,
    );
  });
  // The other side (this tab is the holder) is Dexie's default versionchange
  // handler: it closes with auto-reopen so the upgrader can proceed.
}

const COLLECTION_TABLES: Record<string, Dexie.Table<any, string>> = Object.fromEntries(
  COLLECTION_STORE_KEYS.filter((key) => (db as any)[key]).map((key) => [key, (db as any)[key]])
);

// The schema is derived from the registry, so every registered collection has
// a table by construction; this list should always be empty. Kept as a loud
// runtime guard (a registered collection with no table would reject
// loadCache's Promise.all and silently disable the ENTIRE cache).
export const MISSING_COLLECTION_TABLES: string[] = COLLECTION_STORE_KEYS.filter(
  (key) => !(db as any)[key]
);
if (MISSING_COLLECTION_TABLES.length > 0) {
  console.error(
    `[idbCache] registry collections missing Dexie tables: ${MISSING_COLLECTION_TABLES.join(", ")}`
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

// Test hook: Dexie copies the IndexedDB API into the instance at construction
// and remembers a failed open, so a test running after another file already
// touched the singleton (no IndexedDB in the process then) must hand the
// instance fake-indexeddb and reopen it.
export function _reopenForTests(deps: { indexedDB: unknown; IDBKeyRange: unknown }): Promise<unknown> {
  Object.assign((db as any)._deps, deps);
  db.close();
  return db.open();
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
          // A stub (non-Convex id) is client-minted: no server window or paused
          // hydration can explain its absence, so a stub leaving the store is
          // always an intentional local removal — the altKey supersede or a
          // create rollback. Protecting stubs here is what kept every sent
          // message's stub on disk forever; boot hydration then resurrected it
          // NEXT TO its server twin, and the transcript rendered each of your
          // own messages twice until the next live delivery collapsed them.
          else if (!isConvexId(String(id))) deletes.push(id);
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

// Hydration-time retention policy — shared with the native engine (see
// cacheRetention.ts for the full rationale); re-exported for existing callers.
export { partitionSessionRetention, expireExcludeTombstones };

export async function loadCache(
  keys?: readonly string[],
  context: Record<string, any> = {},
): Promise<Record<string, any> | null> {
  try {
    const result: Record<string, any> = {};
    let hasData = false;

    const wanted = keys ? new Set(keys) : null;
    const collectionEntries = Object.entries(COLLECTION_TABLES)
      .filter(([key]) => !wanted || wanted.has(key));
    const metaKeys = (keys ?? [...META_KEYS]).filter((key) => META_KEYS.has(key));
    const [collectionResults, metaRows] = await Promise.all([
      Promise.all(collectionEntries.map(([, table]) => table.toArray())),
      db.meta.bulkGet(metaKeys),
    ]);

    // Meta lookup first — the sessions retention pass below needs
    // liveInboxIdList and lastFocusedConversationId from the same snapshot.
    const metaByKey: Record<string, any> = { ...context };
    for (const row of metaRows) {
      if (row) metaByKey[row.key] = row.value;
    }

    collectionEntries.forEach(([key, table], i) => {
      let rows = collectionResults[i];
      // Seed the persistence shadow with what's on disk (even an empty table) so
      // the first write after hydrate diffs against reality and can prune rows
      // the server has since deleted.
      const shadow = new Map<string, any>();
      const validRow = collectionRowValidator(key);
      // Trim rows on the way in (see hydrateRow in the registry). Trimmed rows
      // are written straight back so disk shrinks with memory; the shadow then
      // holds the trimmed row (holding the on-disk original would pin the very
      // bytes we just dropped until the collection's next persist).
      const hydrateRow = collectionRowHydrator(key);
      const hydrateCtx = { pending: (metaByKey.pending as Record<string, any> | undefined) ?? {} };
      const trimmed: any[] = [];
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
      // Doc bodies are the heavy rows the thin docs list deliberately sheds —
      // bound the opened-docs cache by last-open recency the same way.
      if (key === "docDetails" && rows.length > 0) {
        const { keep, drop } = partitionDocDetailRetention(rows, Date.now());
        rows = keep;
        if (drop.length) table.bulkDelete(drop).catch(() => {});
      }
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) {
          if (validRow && !validRow(row)) { invalid.push(row._id); continue; }
          const kept = hydrateRow ? hydrateRow(row, hydrateCtx) : row;
          if (kept !== row) trimmed.push(kept);
          map[row._id] = kept; shadow.set(row._id, kept);
        }
        if (Object.keys(map).length > 0) {
          result[key] = map;
          hasData = true;
        }
      }
      if (invalid.length) table.bulkDelete(invalid).catch(() => {});
      if (trimmed.length) table.bulkPut(trimmed).catch(() => {});
      lastPersisted.set(key, shadow);
    });

    for (const row of metaRows) {
      if (!row) continue;
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
// debounced flush and throttled — never on the hot per-tick path. The cap sits
// near the session-row cache floor (partitionSessionRetention keeps ~1200 rows):
// a row the list can show should have its tail on disk, so the click is local.
const MAX_CACHED_CONVERSATIONS = 1000;
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
    if (doomed.size > 0) {
      const ids = [...doomed];
      await db.conversationMessages.bulkDelete(ids);
      await db.conversationUserMessages.bulkDelete(ids);
    }
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

export type CachedConversation = {
  messages: any[];
  pagination: any;
  latestTimestamp: number;
  // Present when the navigator list was persisted for this conversation.
  userMessages?: any[];
};

async function _loadUserMessages(convId: string): Promise<any[] | undefined> {
  try {
    return (await db.conversationUserMessages.get(convId))?.userMessages;
  } catch {
    return undefined;
  }
}

export async function loadConversationMessages(convId: string): Promise<CachedConversation | null> {
  // Read-your-writes: a just-written-but-not-yet-flushed payload is the freshest
  // truth, so serve it before falling back to the persisted IDB row.
  const pending = _pendingMsgWrites.get(convId);
  const userMessages = await _loadUserMessages(convId);
  if (pending) {
    return { messages: pending.messages, pagination: pending.pagination, latestTimestamp: _latestTs(pending.messages), userMessages };
  }
  try {
    const row = await db.conversationMessages.get(convId);
    // A conversation whose navigator list landed before any message page did
    // still hydrates that list; the caller treats empty messages as a miss.
    if (!row) return userMessages ? { messages: [], pagination: undefined, latestTimestamp: 0, userMessages } : null;
    return { messages: row.messages, pagination: row.pagination, latestTimestamp: row.latestTimestamp, userMessages };
  } catch {
    return null;
  }
}

// Small row, written straight through: the store already dedups no-op ticks
// (setUserMessages), so every call here is a real change.
export function writeConversationUserMessages(convId: string, userMessages: any[]) {
  if (_hydrating) return;
  _touchedAt.set(convId, Date.now());
  db.conversationUserMessages.put({ convId, userMessages }).catch(() => {});
}

export function writeConversationMessages(convId: string, messages: any[], pagination: any) {
  if (_hydrating) return;
  _touchedAt.set(convId, Date.now());
  _pendingMsgWrites.set(convId, { messages, pagination });
  if (!_msgWriteTimer) _msgWriteTimer = setTimeout(_flushMessageWrites, MSG_WRITE_DEBOUNCE_MS);
}

// -- Dispatch outbox: persist server-bound mutations until acknowledged --

// Return the real promises: the middleware's storage watchdog and outbox
// retirement need to observe commit/failure. Swallowing errors here would
// report a wedged IndexedDB as healthy.
export function enqueueDispatch(entry: OutboxEntry): Promise<void> {
  return db.dispatchOutbox.put(entry).then(() => {});
}

export function removeDispatch(id: string): Promise<void> {
  return db.dispatchOutbox.delete(id);
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    return await db.dispatchOutbox.orderBy("ts").toArray();
  } catch {
    return [];
  }
}

// -- One-time salvage of the retired local-first v2 databases --
// Earlier builds parked durable writes in per-principal databases
// ("codecast-store-v2:<origin>:<principal>", legacyOutbox store). Move any
// parked rows into the dispatch outbox so nothing a user typed is lost, then
// delete those databases (and the "codecast-launcher-v2:*" launcher metadata).
// Row shape is compatible: both sides persisted the middleware's OutboxEntry.
export async function salvageLocalFirstV2Data(): Promise<number> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return 0;
  let salvaged = 0;
  let names: string[] = [];
  try {
    names = (await indexedDB.databases())
      .map((d) => d.name)
      .filter((n): n is string =>
        !!n && (n.startsWith("codecast-store-v2:") || n.startsWith("codecast-launcher-v2:")));
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      if (name.startsWith("codecast-store-v2:")) {
        const rows = await readV2LegacyOutbox(name);
        for (const row of rows) {
          if (!row || typeof row !== "object" || typeof (row as any).id !== "string") continue;
          await db.dispatchOutbox.put(row as OutboxEntry);
          salvaged++;
        }
      }
      await deleteDatabaseWithTimeout(name);
    } catch (error) {
      console.error(`[idbCache] v2 salvage failed for ${name}`, error);
    }
  }
  if (salvaged > 0) console.warn(`[idbCache] salvaged ${salvaged} parked writes from retired v2 storage`);
  return salvaged;
}

function readV2LegacyOutbox(name: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    // A database wedged by the very failure mode that retired v2 must not
    // wedge boot: give up quietly and let deletion (or the next boot) win.
    const timer = setTimeout(() => resolve([]), 10_000);
    req.onerror = () => { clearTimeout(timer); resolve([]); };
    req.onsuccess = () => {
      const vdb = req.result;
      try {
        if (!vdb.objectStoreNames.contains("legacyOutbox")) {
          clearTimeout(timer); vdb.close(); resolve([]); return;
        }
        const get = vdb.transaction("legacyOutbox", "readonly").objectStore("legacyOutbox").getAll();
        get.onsuccess = () => { clearTimeout(timer); vdb.close(); resolve(get.result ?? []); };
        get.onerror = () => { clearTimeout(timer); vdb.close(); resolve([]); };
      } catch {
        clearTimeout(timer); vdb.close(); resolve([]);
      }
    };
  });
}

function deleteDatabaseWithTimeout(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    // deleteDatabase blocks while another tab holds a connection; don't let
    // that stall boot — the next boot retries.
    const timer = setTimeout(() => resolve(), 10_000);
    const done = () => { clearTimeout(timer); resolve(); };
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = () => { /* keep waiting until timeout */ };
  });
}

// Sign-out purge: drop every locally persisted row (collections, messages,
// meta, parked outbox). The caller owns navigation/reload afterwards.
/** Dexie writes only the diffed rows and lands them itself; nothing is held
 *  back. The native engine schedules whole-blob writes and drains them here. */
export async function flushPersistence(): Promise<void> {}

export async function purgeLocalCache(): Promise<void> {
  _pendingMsgWrites.clear();
  lastPersisted.clear();
  try {
    await db.delete();
  } finally {
    // Dexie reopens lazily on next access; a signed-out page navigates away.
  }
}
