import { captureException } from "./pendingInputError";
import { readPendingMessageJournal, writePendingMessageJournal, type PendingJournalStorage } from "./pendingMessageJournal";
import { importLegacyQueuedMessages, queuedMessagesFromPending, applyPendingMessageWrite, pendingMessageWrites, pendingMessagesFromRecords, type PendingMessages } from "./pendingMessageJournal";
// expo-sqlite's kv-store default export is an AsyncStorage-compatible, SQLite-backed
// key-value store (getItem/setItem/removeItem + multiGet). It is durable and survives
// app restart — the RN replacement for the web Dexie engine. Metro resolves this
// .native file (and its mobile-only expo-sqlite dep) for the native bundle; the web
// bundler and tsconfig never touch it.
//
// CRITICAL — acquire it through a guarded require(), NOT a static import. expo-sqlite
// resolves its native module at module-eval time (`requireNativeModule('ExpoSQLite')`
// THROWS when the installed binary doesn't contain it). An OTA update ships JS only,
// so this code can land on an app binary built BEFORE expo-sqlite was added as a
// native dependency. With a static import the throw propagates up the import chain
// (inboxStore imports this eagerly at startup) and crashes the app on every launch —
// before expo-updates can mark the update "launched", so it auto-rolls-back and the
// update never takes. A guarded require degrades to an in-memory (non-persistent)
// session on those older binaries instead of bricking them; native persistence
// resumes automatically once users get a build that includes the ExpoSQLite module.
import type { Patch } from "mutative";
import {
  COLLECTION_STORE_KEYS,
  META_STORE_KEYS,
  collectionRowValidator,
  collectionRowHydrator,
  isPersistedClientStoreKey,
} from "./clientSyncRegistry";
import { diffCollection, durableDeletes } from "./idbCollectionDiff";
import { partitionSessionRetention, partitionDocDetailRetention, expireExcludeTombstones, persistedMessageTail } from "./cacheRetention";

let Storage: any = null;
// Send writes the pending-input journal with setItemSync. That used to hit the
// same SQLite file as the collection cache, so a new-session send waited on
// whatever blob/row flush was in flight and froze the button for seconds.
let PendingStorage: any = null;
try {
  const kv = require("expo-sqlite/kv-store");
  Storage = kv.default;
  PendingStorage = typeof kv.SQLiteStorage === "function"
    ? new kv.SQLiteStorage("codecast-pending-input")
    : kv.default;
} catch {
  // Tests can't reach this require with bun's mock.module (it intercepts the
  // ESM path only), so the suite injects an AsyncStorage-compatible shim via
  // this global BEFORE importing the module — that also lets the eval-time
  // PERSISTENCE_AVAILABLE const come out true. Absent the global (production
  // on an older binary), degrade to in-memory exactly as before.
  Storage = (globalThis as any).__CODECAST_TEST_KV_STORAGE__ ?? null;
  PendingStorage = Storage;
}

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
};

const COLLECTION_TABLES = new Set<string>(COLLECTION_STORE_KEYS);
const META_KEYS = new Set<string>(META_STORE_KEYS);

// KV key prefixes namespace the flat store so reads can reconstruct the same
// shape Dexie's per-table layout produces.
const COLLECTION_PREFIX = "col:";
const META_PREFIX = "meta:";
const CONVMSG_PREFIX = "convmsg:";
const CONVUSERMSG_PREFIX = "convusermsg:";
const OUTBOX_KEY = "dispatchOutbox";

let _hydrating = false;

// What each collection currently holds on disk, by id → row reference. Seeded
// from loadCache so the first post-hydrate write diffs against disk. Unchanged
// row refs (live queries re-pushing the same objects) produce an empty diff
// and touch SQLite zero times; a changed ref writes that one row key.
const lastPersisted = new Map<string, Map<string, any>>();

// False when the ExpoSQLite native module is absent (OTA shipped to an older
// binary). inboxStore gates its hydrate/persist wiring on this, so the app runs
// in-memory instead of crashing. Every Storage access below is also individually
// null-guarded as defense in depth.
export const PERSISTENCE_AVAILABLE = Storage != null;

// ── Write-behind ─────────────────────────────────────────────────────────────
// Collections used to live as ONE JSON blob per table. A busy account's
// sessions blob is ~4.5 MB and tasks ~6.8 MB; overlay heartbeats change a
// handful of row refs many times a second, and JSON.stringify of the whole
// table on the JS thread froze taps for seconds (and, written eagerly, piled
// strings until Hermes aborted — Sentry REACT-NATIVE-J "LLVM ERROR" inside
// JSON.stringify, watchdog RAM kill REACT-NATIVE-H).
//
// Per-row keys match the web Dexie engine: a heartbeat stringifies one row,
// not the table. Writes are still scheduled, not eager — the latest producer
// wins, a short trailing delay folds a burst, and at most one write per key
// is in flight. A global inflight cap keeps a boot migration of thousands of
// row keys from opening that many SQLite statements at once. Reads of a
// scheduled key see the scheduled value; a null producer is a delete.
const WRITE_COALESCE_MS = 250;
const MAX_INFLIGHT = 8;
type Produce = (() => string) | null;
const pendingWrites = new Map<string, Produce>();
const inflightWrites = new Map<string, Promise<void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// One remove of the leftover whole-table blob per collection per process, so a
// heartbeat does not keep issuing removeItem for a key that is already gone.
const droppedLegacyBlobs = new Set<string>();

// Test hook — see idbCache.ts.
export function _resetPersistedShadow() {
  lastPersisted.clear();
  droppedLegacyBlobs.clear();
  pendingWrites.clear();
  if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
}

function afterInteractions(fn: () => void) {
  try {
    const IM = require("react-native").InteractionManager;
    if (IM?.runAfterInteractions) {
      IM.runAfterInteractions(fn);
      return;
    }
  } catch { /* bun tests have no RN */ }
  fn();
}

function scheduleWrite(key: string, produce: Produce) {
  pendingWrites.set(key, produce);
  if (flushTimer == null) flushTimer = setTimeout(flushScheduledWrites, WRITE_COALESCE_MS);
}

function scheduleRemove(key: string) {
  scheduleWrite(key, null);
}

function flushScheduledWrites() {
  flushTimer = null;
  afterInteractions(flushScheduledWritesNow);
}

function flushScheduledWritesNow() {
  for (const [key, produce] of pendingWrites) {
    if (inflightWrites.has(key)) continue;
    if (inflightWrites.size >= MAX_INFLIGHT) break;
    pendingWrites.delete(key);
    const write = Promise.resolve().then(() => {
      if (produce == null) return Storage.removeItem(key);
      return Storage.setItem(key, produce());
    }).catch(() => {}).then(() => {
      inflightWrites.delete(key);
      if (pendingWrites.size > 0 && flushTimer == null) flushTimer = setTimeout(flushScheduledWrites, 0);
    });
    inflightWrites.set(key, write);
  }
}

/** A scheduled-but-unflushed value, so a read never sees older bytes than the
 *  store has already committed to disk-in-spirit. A pending delete is absent. */
function scheduledValue(key: string): string | undefined {
  if (!pendingWrites.has(key)) return undefined;
  const produce = pendingWrites.get(key);
  return produce ? produce() : undefined;
}

/** Drain every scheduled and in-flight write. Tests and a deliberate shutdown
 *  path want a settled disk; the app itself never needs to wait. */
export async function flushPersistence(): Promise<void> {
  while (pendingWrites.size > 0 || inflightWrites.size > 0) {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    // Tests and shutdown must not wait for the interaction queue.
    flushScheduledWritesNow();
    await Promise.all([...inflightWrites.values()]);
  }
}

// A top-level store key is durable iff it maps to a dedicated collection or is
// whitelisted as a meta blob. Keys that satisfy neither are silently dropped on
// write — the class of bug that lost pending user messages.
export function isPersistedStoreKey(key: string): boolean {
  return isPersistedClientStoreKey(key);
}

const PENDING_INPUT_PREFIX = "pendingInput:v1:";

const pendingJournalStorage: PendingJournalStorage = {
  getItem: key => PendingStorage.getItemSync(key),
  setItem: (key, value) => PendingStorage.setItemSync(key, value),
  removeItem: key => PendingStorage.removeItemSync(key),
  getAllKeys: () => PendingStorage.getAllKeysSync(),
  key: index => PendingStorage.getAllKeysSync()[index] ?? null,
  get length() { return PendingStorage.getAllKeysSync().length; },
};

async function flushPendingInputJournal(): Promise<void> {
  if (!Storage || !PendingStorage) return;
  const batches = readPendingMessageJournal(pendingJournalStorage);
  for (const batch of batches) {
    for (const write of batch.writes) {
      const key = `${PENDING_INPUT_PREFIX}${batch.ownerId}:${write.id}`;
      const raw = await Storage.getItem(key);
      const value = applyPendingMessageWrite(raw ? JSON.parse(raw) : undefined, write);
      await Storage.setItem(key, JSON.stringify(value));
    }
    PendingStorage.removeItemSync(batch.key);
  }
}

export function persistPendingMessageChanges(before: PendingMessages, after: PendingMessages, ownerId?: string): void {
  if (before === after) return;
  const writes = pendingMessageWrites(before, after);
  if (!writes.length) return;
  if (!PendingStorage?.setItemSync) throw new Error("Update Codecast before sending so your messages can be saved safely.");
  if (!ownerId) throw new Error("Sign in before sending a message so it can be saved safely.");
  writePendingMessageJournal(pendingJournalStorage, ownerId, writes);
  void flushPendingInputJournal().catch(error => captureException(error, { tags: { source: "pending-input-journal" } }));
}

async function loadPendingInput(ownerId?: string): Promise<PendingMessages> {
  if (!ownerId || !Storage) return {};
  await flushPendingInputJournal();
  const prefix = `${PENDING_INPUT_PREFIX}${ownerId}:`;
  const legacy = await Storage.getItem(META_PREFIX + "pendingMessages");
  const user = await Storage.getItem(META_PREFIX + "currentUser");
  if (legacy && user && JSON.parse(user)?._id === ownerId) {
    for (const write of pendingMessageWrites({}, JSON.parse(legacy))) {
      const key = prefix + write.id;
      if (Storage.getItemSync(key) !== null) continue;
      Storage.setItemSync(key, JSON.stringify(applyPendingMessageWrite(undefined, write)));
    }
    await Storage.removeItem(META_PREFIX + "pendingMessages");
  }
  const queued = await Storage.getItem(META_PREFIX + "queuedMessages");
  if (queued && user && JSON.parse(user)?._id === ownerId) {
    for (const write of pendingMessageWrites({}, importLegacyQueuedMessages(JSON.parse(queued)))) {
      Storage.setItemSync(prefix + write.id, JSON.stringify(applyPendingMessageWrite(undefined, write)));
    }
    await Storage.removeItem(META_PREFIX + "queuedMessages");
  }
  const keys: string[] = Storage.getAllKeysSync();
  const rows = keys.filter(key => key.startsWith(prefix)).map(key => JSON.parse(Storage.getItemSync(key)));
  return pendingMessagesFromRecords(rows);
}

function collectionBlobKey(key: string): string {
  return COLLECTION_PREFIX + key;
}

function collectionRowKey(key: string, id: string): string {
  return COLLECTION_PREFIX + key + ":" + id;
}

function isCollectionRowKey(storageKey: string, collectionKey: string): boolean {
  return storageKey.startsWith(COLLECTION_PREFIX + collectionKey + ":");
}

function dropLegacyBlob(blobKey: string) {
  if (droppedLegacyBlobs.has(blobKey)) return;
  droppedLegacyBlobs.add(blobKey);
  scheduleRemove(blobKey);
}

// conversations is registered as a meta blob (one JSON object) so web Dexie
// can store it in the meta table. On native that blob is the sessions twin:
// creating a session stringified the whole map on the JS thread and froze
// the send button on a new session. Persist it per-row like collections.
const PER_ROW_META_KEYS = new Set(["conversations"]);

function persistKeyedRows(
  storeKey: string,
  data: Record<string, any>,
  pending: Record<string, { type?: string }>,
  blobKey: string,
  rowKeyFor: (id: string) => string,
) {
  const prevShadow = lastPersisted.get(storeKey);
  const { puts, deletes: rawDeletes, next } = diffCollection(prevShadow, data);
  const deletes = durableDeletes(storeKey, rawDeletes, pending, prevShadow, next);
  lastPersisted.set(storeKey, next);
  if (puts.length || deletes.length) {
    for (const row of puts) {
      if (!row || row._id == null) continue;
      const id = String(row._id);
      scheduleWrite(rowKeyFor(id), () => JSON.stringify(row));
    }
    for (const id of deletes) scheduleRemove(rowKeyFor(id));
    dropLegacyBlob(blobKey);
  }
}

export function writePatchesToIDB(patches: Patch[], state: any) {
  if (!Storage || _hydrating) return;

  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  const pending = (state.pending || {}) as Record<string, { type?: string }>;
  for (const key of affectedKeys) {
    if (key === "pendingMessages" || key === "queuedMessages") continue;
    if (COLLECTION_TABLES.has(key)) {
      const data = state[key];
      if (data && typeof data === "object") {
        persistKeyedRows(key, data, pending, collectionBlobKey(key), (id) => collectionRowKey(key, id));
      }
    } else if (PER_ROW_META_KEYS.has(key)) {
      const data = state[key];
      if (data && typeof data === "object") {
        persistKeyedRows(key, data, pending, META_PREFIX + key, (id) => META_PREFIX + key + ":" + id);
      }
    } else if (META_KEYS.has(key)) {
      scheduleWrite(META_PREFIX + key, () => JSON.stringify(state[key]));
    }
  }
}

// One SQL statement for a whole read instead of one per key. kv-store's
// multiGet runs getFirstAsync per key, and a boot read spans ~22,000 rows;
// every call is a native round trip, and React Native's callback registry
// (LongLivedObjectCollection) walks every outstanding call on each
// completion, so thousands in flight cost a full core for the first minute
// after launch. The table is kv-store's own ("storage": key, value), opened
// read-only beside it. Null when expo-sqlite is not there (tests inject a
// shim), and the callers fall back to the per-key path.
let cacheDb: Promise<any> | null | undefined;
function openCacheDb(): Promise<any> | null {
  if (cacheDb !== undefined) return cacheDb;
  try {
    const name = Storage?.databaseName;
    const { openDatabaseAsync } = require("expo-sqlite");
    cacheDb = typeof name === "string" && typeof openDatabaseAsync === "function"
      ? openDatabaseAsync(name).catch(() => null)
      : null;
  } catch {
    cacheDb = null;
  }
  return cacheDb;
}

let cacheDbSync: any | null | undefined;
function openCacheDbSync(): any | null {
  if (cacheDbSync !== undefined) return cacheDbSync;
  try {
    const name = Storage?.databaseName;
    const { openDatabaseSync } = require("expo-sqlite");
    cacheDbSync = typeof name === "string" && typeof openDatabaseSync === "function" ? openDatabaseSync(name) : null;
  } catch {
    cacheDbSync = null;
  }
  return cacheDbSync;
}

/** What a read covers: whole key prefixes (a collection's rows) and exact keys (blobs, meta). */
export function readPlan(wanted: Set<string> | null): { prefixes: string[]; exact: string[] } {
  const collectionKeys = [...COLLECTION_TABLES].filter(key => !wanted || wanted.has(key));
  const perRowMeta = [...PER_ROW_META_KEYS].filter(key => !wanted || wanted.has(key));
  const metaKeys = [...META_KEYS].filter(key => (!wanted || wanted.has(key)) && !PER_ROW_META_KEYS.has(key));
  return {
    prefixes: [
      ...collectionKeys.map(key => COLLECTION_PREFIX + key + ":"),
      ...perRowMeta.map(key => META_PREFIX + key + ":"),
    ],
    exact: [
      ...collectionKeys.map(collectionBlobKey),
      ...perRowMeta.map(key => META_PREFIX + key),
      ...metaKeys.map(key => META_PREFIX + key),
    ],
  };
}

/** `SELECT key, value` over the plan: a half-open range per prefix, IN for the exact keys. */
export function readPlanSql(plan: { prefixes: string[]; exact: string[] }): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const prefix of plan.prefixes) {
    clauses.push("(key >= ? AND key < ?)");
    params.push(prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1));
  }
  if (plan.exact.length > 0) {
    clauses.push(`key IN (${plan.exact.map(() => "?").join(", ")})`);
    params.push(...plan.exact);
  }
  return { sql: `SELECT key, value FROM storage WHERE ${clauses.join(" OR ") || "0"}`, params };
}

function rowsToMap(rows: { key: string; value: string | null }[]): Map<string, string | null> {
  const byKey = new Map<string, string | null>();
  for (const row of rows) byKey.set(row.key, row.value);
  return byKey;
}

async function storageKeys(): Promise<string[]> {
  if (typeof Storage.getAllKeysSync === "function") return Storage.getAllKeysSync();
  if (typeof Storage.getAllKeys === "function") return await Storage.getAllKeys();
  return [];
}

function collectReadKeys(allKeys: string[], wanted: Set<string> | null): string[] {
  const collectionKeys = [...COLLECTION_TABLES].filter(key => !wanted || wanted.has(key));
  const metaKeys = [...META_KEYS].filter(key => !wanted || wanted.has(key));
  const collectionStorageKeys = allKeys.filter((k: string) =>
    collectionKeys.some((key) => k === collectionBlobKey(key) || isCollectionRowKey(k, key)),
  );
  const perRowMetaKeys = allKeys.filter((k: string) =>
    [...PER_ROW_META_KEYS].some((key) =>
      (!wanted || wanted.has(key)) && (k === META_PREFIX + key || k.startsWith(META_PREFIX + key + ":")),
    ),
  );
  const metaStorageKeys = metaKeys.filter((k) => !PER_ROW_META_KEYS.has(k)).map((k) => META_PREFIX + k);
  return [...collectionStorageKeys, ...perRowMetaKeys, ...metaStorageKeys];
}

function materializeLoadedCache(
  byKey: Map<string, string | null>,
  wanted: Set<string> | null,
): Record<string, any> | null {
  const result: Record<string, any> = {};
  let hasData = false;
  const collectionKeys = [...COLLECTION_TABLES].filter(key => !wanted || wanted.has(key));
  const metaKeys = [...META_KEYS].filter(key => !wanted || wanted.has(key));
  // Meta lookup first — the pending map gates hydrateRow (an unsynced local
  // edit keeps its body), and the sessions retention pass below needs
  // liveInboxIdList and lastFocusedConversationId from the same snapshot.
  const readMeta = (key: string): any => {
    try {
      const raw = byKey.get(META_PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch { return undefined; }
  };
  const metaPending = readMeta("pending") as Record<string, any> | undefined;

  for (const key of collectionKeys) {
      const rows: any[] = [];
      const seen = new Set<string>();
      for (const [storageKey, raw] of byKey) {
        if (!isCollectionRowKey(storageKey, key) || raw == null) continue;
        try {
          const row = JSON.parse(raw);
          if (row?._id == null || seen.has(row._id)) continue;
          seen.add(row._id);
          rows.push(row);
        } catch { /* skip a corrupt row; the next put overwrites it */ }
      }
      const blobRaw = byKey.get(collectionBlobKey(key));
      let hadLegacyBlob = false;
      if (blobRaw != null) {
        hadLegacyBlob = true;
        try {
          const blobRows = JSON.parse(blobRaw) as any[];
          if (Array.isArray(blobRows)) {
            for (const row of blobRows) {
              if (row?._id == null || seen.has(row._id)) continue;
              seen.add(row._id);
              rows.push(row);
            }
          }
        } catch { /* drop a corrupt blob; per-row keys still load */ }
      }
      if (rows.length === 0 && !hadLegacyBlob) {
        lastPersisted.set(key, new Map());
        continue;
      }
      // Seed the persistence shadow with what's on disk so the first write after
      // hydrate diffs against reality (see idbCache.ts).
      const shadow = new Map<string, any>();
      const validRow = collectionRowValidator(key);
      const hydrateRow = collectionRowHydrator(key);
      const hydrateCtx = { pending: (metaPending as Record<string, any> | undefined) ?? {} };
      let keptRows = rows;
      const dropped = new Set<string>();
      if (key === "sessions" && keptRows.length > 0) {
        const { keep, drop } = partitionSessionRetention(
          keptRows,
          readMeta("liveInboxIdList"),
          readMeta("lastFocusedConversationId"),
          Date.now(),
        );
        keptRows = keep;
        for (const id of drop) dropped.add(id);
      }
      // Opened-docs body cache: bound by last-open recency (see idbCache.ts).
      if (key === "docDetails" && keptRows.length > 0) {
        const { keep, drop } = partitionDocDetailRetention(keptRows, Date.now());
        keptRows = keep;
        for (const id of drop) dropped.add(id);
      }
      const map: Record<string, any> = {};
      let anyTrimmed = false;
      for (const row of keptRows) {
        // Foreign documents persisted under the wrong collection (see validRow
        // in the registry) never enter the store or the shadow; dropping the
        // row key is how the prune reaches disk.
        if (validRow && !validRow(row)) {
          dropped.add(row._id);
          continue;
        }
        // Trimmed on the way in (registry hydrateRow). The shadow holds the
        // trimmed row (the original would pin the dropped bytes); the row key
        // is rewritten below so disk shrinks too.
        const kept = hydrateRow ? hydrateRow(row, hydrateCtx) : row;
        if (kept !== row) anyTrimmed = true;
        map[row._id] = kept; shadow.set(row._id, kept);
      }
      if (anyTrimmed) {
        for (const row of Object.values(map)) {
          scheduleWrite(collectionRowKey(key, String(row._id)), () => JSON.stringify(row));
        }
      }
      for (const id of dropped) scheduleRemove(collectionRowKey(key, id));
      if (hadLegacyBlob) {
        // Split the leftover whole-table blob into per-row keys so the next
        // heartbeat cannot stringify the table again.
        if (!anyTrimmed) {
          for (const row of Object.values(map)) {
            scheduleWrite(collectionRowKey(key, String(row._id)), () => JSON.stringify(row));
          }
        }
        dropLegacyBlob(collectionBlobKey(key));
      }
      if (Object.keys(map).length > 0) {
        result[key] = map;
        hasData = true;
      }
      lastPersisted.set(key, shadow);
    }

    for (const key of metaKeys) {
      if (PER_ROW_META_KEYS.has(key)) continue;
      const raw = byKey.get(META_PREFIX + key);
      if (raw == null) continue;
      result[key] = JSON.parse(raw);
      hasData = true;
    }

    // conversations is the sessions twin. Load per-row keys (and a leftover
    // whole-map blob), then apply the same retention policy.
    if (!wanted || wanted.has("conversations")) {
      const convPrefix = META_PREFIX + "conversations:";
      const convBlobKey = META_PREFIX + "conversations";
      const convMap: Record<string, any> = {};
      for (const [storageKey, raw] of byKey) {
        if (!storageKey.startsWith(convPrefix) || raw == null) continue;
        try {
          const row = JSON.parse(raw);
          if (row?._id != null) convMap[row._id] = row;
        } catch { /* skip a corrupt row */ }
      }
      const convBlob = byKey.get(convBlobKey);
      let hadConvBlob = false;
      if (convBlob != null) {
        hadConvBlob = true;
        try {
          const parsed = JSON.parse(convBlob);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const row of Object.values(parsed) as any[]) {
              if (row?._id != null && convMap[row._id] == null) convMap[row._id] = row;
            }
          }
        } catch { /* drop a corrupt blob; per-row keys still load */ }
      }
      if (Object.keys(convMap).length > 0) {
        const { keep, drop } = partitionSessionRetention(
          Object.values(convMap),
          readMeta("liveInboxIdList"),
          readMeta("lastFocusedConversationId"),
          Date.now(),
        );
        const pruned: Record<string, any> = {};
        const shadow = new Map<string, any>();
        for (const row of keep) {
          pruned[row._id] = row;
          shadow.set(row._id, row);
        }
        result.conversations = pruned;
        lastPersisted.set("conversations", shadow);
        hasData = true;
        for (const id of drop) scheduleRemove(convPrefix + id);
        if (hadConvBlob) {
          for (const row of keep) {
            scheduleWrite(convPrefix + String(row._id), () => JSON.stringify(row));
          }
          dropLegacyBlob(convBlobKey);
        }
      } else {
        lastPersisted.set("conversations", new Map());
      }
    }

  if (result.pending && typeof result.pending === "object") {
    result.pending = expireExcludeTombstones(result.pending, Date.now());
  }

  return hasData ? result : null;
}

// Same bytes as loadCache, on this thread. expo-sqlite's kv-store exposes
// getItemSync; using it at module eval means the store already holds sessions
// before React's first paint — kill-and-reopen then looks like web/desktop.
export function loadCacheSync(
  keys?: readonly string[],
  _context: Record<string, any> = {},
): Record<string, any> | null {
  if (!Storage || typeof Storage.getItemSync !== "function") return null;
  if (typeof Storage.getAllKeysSync !== "function") return null;
  try {
    const wanted = keys ? new Set(keys) : null;
    const db = openCacheDbSync();
    let byKey: Map<string, string | null>;
    if (db) {
      const { sql, params } = readPlanSql(readPlan(wanted));
      byKey = rowsToMap(db.getAllSync(sql, params));
      for (const key of byKey.keys()) {
        const scheduled = scheduledValue(key);
        if (scheduled !== undefined) byKey.set(key, scheduled);
      }
    } else {
      byKey = new Map<string, string | null>();
      for (const key of collectReadKeys(Storage.getAllKeysSync() as string[], wanted)) {
        byKey.set(key, scheduledValue(key) ?? Storage.getItemSync(key));
      }
    }
    return materializeLoadedCache(byKey, wanted);
  } catch {
    return null;
  }
}

export function loadPaintCacheSync(): Record<string, any> | null {
  if (!Storage || typeof Storage.getItemSync !== "function") return null;
  const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  try {
    const readMeta = (key: string): any => {
      try {
        const raw = scheduledValue(META_PREFIX + key) ?? Storage.getItemSync(META_PREFIX + key);
        return raw == null ? undefined : JSON.parse(raw);
      } catch { return undefined; }
    };
    const liveInboxIdList = readMeta("liveInboxIdList");
    const lastFocusedConversationId = readMeta("lastFocusedConversationId");
    const teamInboxIdSnapshot = readMeta("teamInboxIdSnapshot");
    const clientState = readMeta("clientState");
    const pending = readMeta("pending");
    const collapsedSections = readMeta("collapsedSections");
    const ids = new Set<string>();
    if (Array.isArray(liveInboxIdList)) {
      for (const id of liveInboxIdList) if (typeof id === "string") ids.add(id);
    }
    if (typeof lastFocusedConversationId === "string") ids.add(lastFocusedConversationId);
    if (Array.isArray(teamInboxIdSnapshot?.ids)) {
      for (const id of teamInboxIdSnapshot.ids) if (typeof id === "string") ids.add(id);
    }

    if (ids.size === 0) {
      // No live-set pointer on disk: scan just the paint keys, not the whole
      // critical set (conversations twin, feed, drafts, roster, …).
      return loadCacheSync([
        "sessions",
        "clientState",
        "pending",
        "collapsedSections",
        "liveInboxIdList",
        "lastFocusedConversationId",
        "teamInboxIdSnapshot",
      ]);
    }

    const sessions: Record<string, any> = {};
    for (const id of ids) {
      const raw = scheduledValue(collectionRowKey("sessions", id)) ?? Storage.getItemSync(collectionRowKey("sessions", id));
      if (raw == null) continue;
      try {
        const row = JSON.parse(raw);
        if (row?._id) sessions[row._id] = row;
      } catch { /* skip a corrupt row */ }
    }
    const result: Record<string, any> = {};
    if (Object.keys(sessions).length > 0) result.sessions = sessions;
    if (liveInboxIdList != null) result.liveInboxIdList = liveInboxIdList;
    if (lastFocusedConversationId != null) result.lastFocusedConversationId = lastFocusedConversationId;
    if (teamInboxIdSnapshot != null) result.teamInboxIdSnapshot = teamInboxIdSnapshot;
    if (clientState != null) result.clientState = clientState;
    if (pending != null) result.pending = pending;
    if (collapsedSections != null) result.collapsedSections = collapsedSections;
    if (Object.keys(result).length === 0) return null;
    const dt = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - t0);
    console.log(`[boot] ${dt}ms paintCache sessions=${Object.keys(sessions).length} ids=${ids.size}`);
    return result;
  } catch {
    return null;
  }
}

export async function loadCache(keys?: readonly string[], context: Record<string, any> = {}): Promise<Record<string, any> | null> {
  if (!Storage) return null;
  try {
    const wanted = keys ? new Set(keys) : null;
    const db = await openCacheDb();
    let byKey: Map<string, string | null>;
    if (db) {
      const { sql, params } = readPlanSql(readPlan(wanted));
      byKey = rowsToMap(await db.getAllAsync(sql, params));
    } else {
      const allKeys = await storageKeys();
      byKey = new Map(await Storage.multiGet(collectReadKeys(allKeys, wanted))) as Map<string, string | null>;
    }
    const result: Record<string, any> = materializeLoadedCache(byKey, wanted) ?? {};
    let hasData = Object.keys(result).length > 0;

    if (!wanted || wanted.has("pendingMessages") || wanted.has("queuedMessages")) {
      const rawUser = await Storage.getItem(META_PREFIX + "currentUser");
      const ownerId = context.currentUser?._id ?? result.currentUser?._id ?? (rawUser ? JSON.parse(rawUser)?._id : undefined);
      if (ownerId) {
        result.pendingMessages = await loadPendingInput(ownerId);
        result.queuedMessages = queuedMessagesFromPending(result.pendingMessages);
        hasData = true;
      }
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

export type CachedConversation = {
  messages: any[];
  pagination: any;
  latestTimestamp: number;
  userMessages?: any[];
};

async function loadUserMessages(convId: string): Promise<any[] | undefined> {
  try {
    const raw = scheduledValue(CONVUSERMSG_PREFIX + convId) ?? await Storage.getItem(CONVUSERMSG_PREFIX + convId);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function loadConversationMessages(convId: string): Promise<CachedConversation | null> {
  if (!Storage) return null;
  try {
    const userMessages = await loadUserMessages(convId);
    const raw = scheduledValue(CONVMSG_PREFIX + convId) ?? await Storage.getItem(CONVMSG_PREFIX + convId);
    if (raw == null) return userMessages ? { messages: [], pagination: undefined, latestTimestamp: 0, userMessages } : null;
    const row = JSON.parse(raw);
    return { messages: row.messages, pagination: row.pagination, latestTimestamp: row.latestTimestamp, userMessages };
  } catch {
    return null;
  }
}

export function writeConversationUserMessages(convId: string, userMessages: any[]) {
  if (!Storage || _hydrating) return;
  scheduleWrite(CONVUSERMSG_PREFIX + convId, () => JSON.stringify(userMessages));
}

export function writeConversationMessages(convId: string, messages: any[], pagination: any) {
  if (!Storage || _hydrating) return;
  // Everything runs at flush time: the array is the store's own, finalized by
  // then, and a spread over thousands of rows would overflow the call stack.
  scheduleWrite(CONVMSG_PREFIX + convId, () => {
    const tail = persistedMessageTail(messages, pagination);
    let latestTimestamp = 0;
    for (const m of tail.messages) if ((m?.timestamp || 0) > latestTimestamp) latestTimestamp = m.timestamp;
    return JSON.stringify({ messages: tail.messages, pagination: tail.pagination, latestTimestamp });
  });
}

// -- Dispatch outbox: persist server-bound mutations until acknowledged --
// Stored as a single JSON array. Each mutation is a read-modify-write on that
// blob, so concurrent enqueue/remove calls must be serialized — otherwise two
// in-flight calls read the same stale array and the second clobbers the first.
// We chain every mutation onto a single tail promise to enforce ordering.

async function readOutbox(): Promise<OutboxEntry[]> {
  if (!Storage) return [];
  const raw = await Storage.getItem(OUTBOX_KEY);
  if (raw == null) return [];
  return JSON.parse(raw) as OutboxEntry[];
}

let _outboxQueue: Promise<unknown> = Promise.resolve();

function mutateOutbox(transform: (entries: OutboxEntry[]) => OutboxEntry[]) {
  if (!Storage) return;
  _outboxQueue = _outboxQueue
    .then(() => readOutbox())
    .then((entries) => Storage.setItem(OUTBOX_KEY, JSON.stringify(transform(entries))))
    .catch(() => {});
}

export function enqueueDispatch(entry: OutboxEntry) {
  mutateOutbox((entries) => [...entries.filter((e) => e.id !== entry.id), entry]);
}

export function removeDispatch(id: string) {
  mutateOutbox((entries) => entries.filter((e) => e.id !== id));
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    // Drain queued writes first so the read reflects every prior enqueue/remove.
    await _outboxQueue;
    return (await readOutbox()).sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

// Web-only surfaces, stubbed for Metro: the retired browser v2 databases never
// existed on native, and sign-out purge has its own native path.
export async function salvageLocalFirstV2Data(): Promise<number> {
  return 0;
}

export async function purgeLocalCache(): Promise<void> {}

// Mobile runs one process on one connection, so a schema upgrade is never
// blocked by another window. Present so the store wires one code path.
export function setUpgradeBlockedListener(_fn: ((blocked: boolean) => void) | null) {}

