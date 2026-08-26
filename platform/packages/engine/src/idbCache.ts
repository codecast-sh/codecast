import Dexie from "dexie";
import type { Patch } from "mutative";
import { diffCollection } from "./idbCollectionDiff";
import { deriveRegistryMaps, type RegistryMaps } from "./registry";
import type { OutboxEntry, PlatformConfig } from "./types";

export const PERSISTENCE_AVAILABLE = typeof window !== "undefined" && typeof indexedDB !== "undefined";

// Default retention for the detail tables. Every detail row ever written stays
// on disk unless something prunes it, and detail payloads are the large ones
// (message bodies with inline images), so an unbounded store climbs into the
// hundreds of MB.
const DEFAULT_DETAIL_MAX_ROWS = 300;
const DEFAULT_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_WRITE_DEBOUNCE_MS = 300;
const DETAIL_PRUNE_THROTTLE_MS = 5 * 60 * 1000; // at most once per 5 min
const DETAIL_PROTECT_RECENT_MS = 10 * 60 * 1000; // never prune a row touched this recently

// Exclude tombstones never clear for delta tables (absence ≠ deletion in
// applySyncTable), so every removal adds a permanent `pending` entry — measured
// at 1,832 entries after a heavy fan-out, and each one rides every sync push and
// every persisted pending blob. A tombstone only matters while the server could
// still resend the row, so age them out at hydration. Legacy entries without a
// timestamp get stamped `now` and age out one window later. include/field
// entries are local-first writes awaiting acknowledgment: never expired.
export const DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function expireExcludeTombstones(
  pending: Record<string, any>,
  now: number,
  ttlMs: number = DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS,
  isUnprotectedField?: (key: string, field: string) => boolean,
): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, entry] of Object.entries(pending)) {
    if (entry?.type === "exclude") {
      if (!entry.ts) { cleaned[key] = { ...entry, ts: now }; continue; }
      if (now - entry.ts > ttlMs) continue;
    }
    // A field the registry now declares unprotected can hold no lock — drop
    // stale entries persisted by older builds (including corrupted ones whose
    // value shape can never echo), or they would keep overriding every server
    // push forever.
    if (entry?.type === "field" && isUnprotectedField) {
      const first = key.indexOf(":");
      const second = key.indexOf(":", first + 1);
      if (
        first !== -1 && second !== -1 &&
        isUnprotectedField(key.slice(0, first), key.slice(second + 1))
      ) continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}

export type DetailRecord = { value: any; latestTimestamp: number };

/** The persistence contract, independent of the backing store. The Dexie cache
 *  implements it for the web; the KV cache implements it for native. */
export type PlatformCache = {
  writePatchesToIDB: (patches: Patch[], state: any) => void;
  loadCache: () => Promise<Record<string, any> | null>;
  setHydrating: (v: boolean) => void;
  loadDetail: (table: string, key: string) => Promise<DetailRecord | null>;
  writeDetail: (table: string, key: string, value: any) => void;
  flushDetail: () => void;
  enqueueDispatch: (entry: OutboxEntry) => Promise<void>;
  removeDispatch: (id: string) => Promise<void>;
  loadOutbox: () => Promise<OutboxEntry[]>;
  purgeLocalCache: () => Promise<void>;
};

export type IdbCache = PlatformCache & {
  db: Dexie;
  /** Test hook: the persisted shadow would otherwise leak across tests. */
  _resetPersistedShadow: () => void;
};

export function createIdbCache(
  config: PlatformConfig,
  maps: RegistryMaps = deriveRegistryMaps(config.registry),
): IdbCache {
  const detailTables = config.detailTables ?? {};
  const tombstoneTtl = config.excludeTombstoneTtlMs ?? DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS;

  // Schema derived from the registry: one table per persisted collection, the
  // shared meta blob table, one table per detail table, and the dispatch outbox.
  const stores: Record<string, string> = { meta: "key", dispatchOutbox: "id, ts" };
  for (const key of maps.collectionStoreKeys) stores[key] = "_id";
  for (const [name, detail] of Object.entries(detailTables)) {
    stores[name] = `${detail.keyField}, latestTimestamp`;
  }

  const db = new Dexie(config.dbName);
  db.version(config.dbVersion).stores(stores);

  const collectionTables: Record<string, Dexie.Table<any, string>> = Object.fromEntries(
    maps.collectionStoreKeys.map((key) => [key, (db as any)[key] as Dexie.Table<any, string>]),
  );
  const metaTable = (db as any).meta as Dexie.Table<{ key: string; value: any }, string>;
  const outboxTable = (db as any).dispatchOutbox as Dexie.Table<OutboxEntry, string>;
  const metaKeys = new Set<string>(maps.metaStoreKeys);

  let hydrating = false;

  // What each collection table currently holds on disk, by id → row reference.
  // Lets writePatchesToIDB persist only the rows that actually changed (and
  // delete the ones that disappeared) instead of clearing + re-pouring the whole
  // table. Seeded from loadCache so the first post-hydrate write diffs against
  // disk, not an empty set (which would leave pruned rows stranded as ghosts).
  const lastPersisted = new Map<string, Map<string, any>>();

  function writePatchesToIDB(patches: Patch[], state: any): void {
    if (hydrating) return;

    const affectedKeys = new Set<string>();
    for (const patch of patches) {
      const path = patch.path as (string | number)[];
      if (path.length > 0) affectedKeys.add(String(path[0]));
    }

    for (const key of affectedKeys) {
      const table = collectionTables[key];
      if (table) {
        const data = state[key];
        if (data && typeof data === "object") {
          const prevShadow = lastPersisted.get(key);
          const { puts, deletes: rawDeletes, next } = diffCollection(prevShadow, data);
          // NEVER wipe the cache from a store-shrink. A row leaves IDB ONLY when
          // it was explicitly removed — a delete plants a `${key}:${id}` exclude
          // in `pending`. A diff-delete with NO exclude means the in-memory store
          // is merely MISSING the row (a paused hydration, a windowed live
          // payload, a bug), so keep it on disk AND in the shadow. Read-time
          // filters hide stale rows; the durable cache is never destroyed. This
          // makes a whole-collection wipe structurally impossible — only
          // intentional per-row removals delete.
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
            // touched. Replaces a clear()+bulkPut full-table rewrite.
            db.transaction("rw", table, async () => {
              if (deletes.length) await table.bulkDelete(deletes);
              if (puts.length) await table.bulkPut(puts);
            }).catch(() => {});
          }
        }
      } else if (metaKeys.has(key)) {
        metaTable.put({ key, value: state[key] }).catch(() => {});
      }
    }
  }

  async function loadCache(): Promise<Record<string, any> | null> {
    try {
      const result: Record<string, any> = {};
      let hasData = false;

      const collectionEntries = Object.entries(collectionTables);
      const [collectionResults, metaRows] = await Promise.all([
        Promise.all(collectionEntries.map(([, table]) => table.toArray())),
        metaTable.toArray(),
      ]);

      collectionEntries.forEach(([key, table], i) => {
        const rows = collectionResults[i];
        // Seed the persistence shadow with what's on disk (even an empty table)
        // so the first write after hydrate diffs against reality and can prune
        // rows the server has since deleted.
        const shadow = new Map<string, any>();
        const validRow = maps.collectionRowValidator(key);
        // Foreign documents persisted under the wrong collection (see validRow
        // in the registry) are excluded from hydration AND removed from disk, so
        // the cache self-heals instead of resurrecting phantoms on every load.
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

      if (result.pending && typeof result.pending === "object") {
        result.pending = expireExcludeTombstones(result.pending, Date.now(), tombstoneTtl, maps.isUnprotectedField);
      }

      return hasData ? result : null;
    } catch {
      return null;
    }
  }

  function setHydrating(v: boolean): void {
    hydrating = v;
  }

  // -- Detail tables --

  // IDB writes are coalesced per key. A detail write fires on nearly every live
  // tick for the open record, and each write serializes the ENTIRE payload — a
  // single put can be multiple MB. Writing the whole thing on every tick is pure
  // waste: this row is a reload cache, not the live source of truth (the
  // in-memory store is, and it still updates synchronously). We keep only the
  // latest payload per key and flush on a short trailing timer, collapsing a
  // burst of N ticks into one write. The timer is scheduled once per burst (not
  // reset on each write), so a continuous stream still flushes at most every
  // DEBOUNCE_MS rather than starving. Reads consult the pending buffer first for
  // read-your-writes, and page-hide flushes so an abrupt close still persists
  // the freshest state.
  const pendingDetailWrites = new Map<string, Map<string, any>>();
  let detailWriteTimer: ReturnType<typeof setTimeout> | null = null;
  // Wall-clock of the last write per key — a record open on screen is written
  // continuously, so a recent touch marks it protected from pruning even if its
  // own freshness stamp is old.
  const detailTouchedAt = new Map<string, Map<string, number>>();
  const detailLastPruneAt = new Map<string, number>();

  const detailStamp = (table: string, value: any): number => {
    const derive = detailTables[table]?.latestTimestamp;
    if (!derive) return Date.now();
    try {
      return derive(value) || Date.now();
    } catch {
      return Date.now();
    }
  };

  function flushDetail(): void {
    if (detailWriteTimer) {
      clearTimeout(detailWriteTimer);
      detailWriteTimer = null;
    }
    if (pendingDetailWrites.size === 0) return;
    const batch = Array.from(pendingDetailWrites.entries());
    pendingDetailWrites.clear();
    for (const [tableName, byKey] of batch) {
      const detail = detailTables[tableName];
      const table = (db as any)[tableName] as Dexie.Table<any, string> | undefined;
      if (!detail || !table) continue;
      for (const [key, value] of byKey) {
        table
          .put({ [detail.keyField]: key, value, latestTimestamp: detailStamp(tableName, value) })
          .catch(() => {});
      }
      maybePruneDetail(tableName);
    }
  }

  // Drop detail rows beyond the cap (oldest by latestTimestamp) and past the
  // TTL, skipping any key currently buffered or recently touched. Reads only
  // primary keys off the latestTimestamp index, so the large payloads are never
  // loaded; best-effort and never throws.
  async function pruneDetail(tableName: string): Promise<void> {
    try {
      const detail = detailTables[tableName];
      const table = (db as any)[tableName] as Dexie.Table<any, string> | undefined;
      if (!detail || !table) return;
      const now = Date.now();
      const maxRows = detail.maxRows ?? DEFAULT_DETAIL_MAX_ROWS;
      const ttlMs = detail.ttlMs ?? DEFAULT_DETAIL_TTL_MS;

      const protectedKeys = new Set<string>(pendingDetailWrites.get(tableName)?.keys() ?? []);
      const touched = detailTouchedAt.get(tableName);
      if (touched) {
        for (const [key, ts] of touched) {
          if (now - ts <= DETAIL_PROTECT_RECENT_MS) protectedKeys.add(key);
          else touched.delete(key); // let the recency map self-bound
        }
      }

      // Ascending by latestTimestamp (oldest first); everything past the cap is
      // the least-recently-active tail. primaryKeys() reads the index only.
      const orderedKeys = await table.orderBy("latestTimestamp").primaryKeys();
      const overCap =
        orderedKeys.length > maxRows ? orderedKeys.slice(0, orderedKeys.length - maxRows) : [];
      const expired = await table
        .where("latestTimestamp")
        .below(now - ttlMs)
        .primaryKeys();

      const doomed = new Set<string>([...(overCap as string[]), ...(expired as string[])]);
      for (const key of protectedKeys) doomed.delete(key);
      if (doomed.size > 0) await table.bulkDelete([...doomed]);
    } catch {
      // Maintenance is best-effort — the durable cache tolerates skipped prunes.
    }
  }

  function maybePruneDetail(tableName: string): void {
    const now = Date.now();
    if (now - (detailLastPruneAt.get(tableName) ?? 0) < DETAIL_PRUNE_THROTTLE_MS) return;
    detailLastPruneAt.set(tableName, now);
    void pruneDetail(tableName);
  }

  async function loadDetail(tableName: string, key: string): Promise<DetailRecord | null> {
    // Read-your-writes: a just-written-but-not-yet-flushed payload is the
    // freshest truth, so serve it before falling back to the persisted row.
    const buffered = pendingDetailWrites.get(tableName)?.get(key);
    if (buffered !== undefined) {
      return { value: buffered, latestTimestamp: detailStamp(tableName, buffered) };
    }
    try {
      const detail = detailTables[tableName];
      const table = (db as any)[tableName] as Dexie.Table<any, string> | undefined;
      if (!detail || !table) return null;
      const row = await table.get(key);
      if (!row) return null;
      return { value: row.value, latestTimestamp: row.latestTimestamp };
    } catch {
      return null;
    }
  }

  function writeDetail(tableName: string, key: string, value: any): void {
    if (hydrating) return;
    if (!detailTables[tableName]) return;
    let touched = detailTouchedAt.get(tableName);
    if (!touched) detailTouchedAt.set(tableName, (touched = new Map()));
    touched.set(key, Date.now());
    let byKey = pendingDetailWrites.get(tableName);
    if (!byKey) pendingDetailWrites.set(tableName, (byKey = new Map()));
    byKey.set(key, value);
    if (!detailWriteTimer) detailWriteTimer = setTimeout(flushDetail, DETAIL_WRITE_DEBOUNCE_MS);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushDetail);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDetail();
    });
  }

  // -- Dispatch outbox: persist server-bound mutations until acknowledged --

  // Return the real promises: the middleware's storage watchdog and outbox
  // retirement need to observe commit/failure. Swallowing errors here would
  // report a wedged IndexedDB as healthy.
  function enqueueDispatch(entry: OutboxEntry): Promise<void> {
    return outboxTable.put(entry).then(() => {});
  }

  function removeDispatch(id: string): Promise<void> {
    return outboxTable.delete(id);
  }

  async function loadOutbox(): Promise<OutboxEntry[]> {
    try {
      return await outboxTable.orderBy("ts").toArray();
    } catch {
      return [];
    }
  }

  // Sign-out purge: drop every locally persisted row (collections, detail rows,
  // meta, parked outbox). The caller owns navigation/reload afterwards.
  async function purgeLocalCache(): Promise<void> {
    pendingDetailWrites.clear();
    lastPersisted.clear();
    await db.delete();
    // Dexie reopens lazily on next access; a signed-out page navigates away.
  }

  return {
    db,
    writePatchesToIDB,
    loadCache,
    setHydrating,
    loadDetail,
    writeDetail,
    flushDetail,
    enqueueDispatch,
    removeDispatch,
    loadOutbox,
    purgeLocalCache,
    _resetPersistedShadow: () => lastPersisted.clear(),
  };
}
