import type { Patch } from "mutative";
import {
  DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS,
  expireExcludeTombstones,
  type DetailRecord,
  type PlatformCache,
} from "./idbCache";
import { deriveRegistryMaps, type RegistryMaps } from "./registry";
import type { OutboxEntry, PlatformConfig } from "./types";

// PlatformCache over a plain async key/value store — the native persistence
// backend (expo-sqlite/kv-store, AsyncStorage) where IndexedDB doesn't exist.
// Layout, all JSON under a dbName namespace:
//   <db>/collection/<key>   full collection map (id → row)
//   <db>/meta/<key>         one meta value
//   <db>/detail/<table>/<k> one DetailRecord
//   <db>/detail-index/<t>   { key: latestTimestamp } for pruning without scans
//   <db>/outbox             OutboxEntry[]
//
// Collections persist as whole blobs (not per-row like Dexie): a mail-sized
// collection serializes in single-digit ms, and blob writes keep the KV story
// simple. Writes debounce on a trailing timer; the outbox writes immediately
// because it is the durability path the middleware's watchdog observes.

export type KVStore = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

const COLLECTION_WRITE_DEBOUNCE_MS = 400;
const DETAIL_WRITE_DEBOUNCE_MS = 300;
const DEFAULT_DETAIL_MAX_ROWS = 300;
const DEFAULT_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createKVCache(
  config: PlatformConfig,
  kv: KVStore,
  maps: RegistryMaps = deriveRegistryMaps(config.registry),
): PlatformCache & { flushAll: () => void } {
  const ns = config.dbName;
  const detailTables = config.detailTables ?? {};
  const tombstoneTtl = config.excludeTombstoneTtlMs ?? DEFAULT_EXCLUDE_TOMBSTONE_TTL_MS;
  const collectionKey = (key: string) => `${ns}/collection/${key}`;
  const metaKey = (key: string) => `${ns}/meta/${key}`;
  const detailKey = (table: string, key: string) => `${ns}/detail/${table}/${key}`;
  const detailIndexKey = (table: string) => `${ns}/detail-index/${table}`;
  const outboxKey = `${ns}/outbox`;

  const metaKeys = new Set<string>(maps.metaStoreKeys);
  const collectionKeys = new Set<string>(maps.collectionStoreKeys);

  let hydrating = false;

  // Last-persisted rows per collection: the "never wipe" rule needs to know
  // what disk holds so a row merely missing from memory survives the write.
  const shadow = new Map<string, Record<string, any>>();

  // Trailing-debounced dirty keys: collection/meta names touched since flush.
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastState: any = null;

  function put(key: string, value: unknown): void {
    kv.setItem(key, JSON.stringify(value)).catch(() => {});
  }

  function flushCollections(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!lastState || dirty.size === 0) return;
    const state = lastState;
    const pending = (state.pending || {}) as Record<string, { type?: string }>;
    for (const key of dirty) {
      if (collectionKeys.has(key)) {
        const data = state[key];
        if (!data || typeof data !== "object") continue;
        // Same rule as the Dexie cache: a row leaves disk ONLY on an explicit
        // removal (an `exclude` pending entry). A row missing from memory —
        // windowed live payload, paused hydration — stays cached.
        const prev = shadow.get(key);
        const next: Record<string, any> = { ...data };
        if (prev) {
          for (const id in prev) {
            if (!(id in next) && pending[`${key}:${id}`]?.type !== "exclude") {
              next[id] = prev[id];
            }
          }
        }
        shadow.set(key, next);
        put(collectionKey(key), next);
      } else if (metaKeys.has(key)) {
        put(metaKey(key), state[key]);
      }
    }
    dirty.clear();
  }

  function writePatchesToIDB(patches: Patch[], state: any): void {
    if (hydrating) return;
    lastState = state;
    for (const patch of patches) {
      const path = patch.path as (string | number)[];
      if (path.length > 0) dirty.add(String(path[0]));
    }
    // Scheduled once per burst (not reset per write) so a continuous stream
    // still flushes every DEBOUNCE_MS instead of starving.
    if (!flushTimer) flushTimer = setTimeout(flushCollections, COLLECTION_WRITE_DEBOUNCE_MS);
  }

  async function loadCache(): Promise<Record<string, any> | null> {
    try {
      const result: Record<string, any> = {};
      let hasData = false;

      const collections = [...collectionKeys];
      const metas = [...metaKeys];
      const [collectionBlobs, metaBlobs] = await Promise.all([
        Promise.all(collections.map((key) => kv.getItem(collectionKey(key)))),
        Promise.all(metas.map((key) => kv.getItem(metaKey(key)))),
      ]);

      collections.forEach((key, i) => {
        const raw = collectionBlobs[i];
        if (!raw) {
          shadow.set(key, {});
          return;
        }
        try {
          const map = JSON.parse(raw) as Record<string, any>;
          const validRow = maps.collectionRowValidator(key);
          if (validRow) {
            for (const id in map) if (!validRow(map[id])) delete map[id];
          }
          shadow.set(key, map);
          if (Object.keys(map).length > 0) {
            result[key] = map;
            hasData = true;
          }
        } catch {
          shadow.set(key, {});
        }
      });

      metas.forEach((key, i) => {
        const raw = metaBlobs[i];
        if (raw == null) return;
        try {
          result[key] = JSON.parse(raw);
          hasData = true;
        } catch {}
      });

      if (result.pending && typeof result.pending === "object") {
        result.pending = expireExcludeTombstones(result.pending, Date.now(), tombstoneTtl);
      }

      return hasData ? result : null;
    } catch {
      return null;
    }
  }

  function setHydrating(v: boolean): void {
    hydrating = v;
  }

  // -- Detail tables (buffered like the Dexie cache) --

  const pendingDetailWrites = new Map<string, Map<string, any>>();
  let detailWriteTimer: ReturnType<typeof setTimeout> | null = null;

  const detailStamp = (table: string, value: any): number => {
    const derive = detailTables[table]?.latestTimestamp;
    if (!derive) return Date.now();
    try {
      return derive(value) || Date.now();
    } catch {
      return Date.now();
    }
  };

  async function readIndex(table: string): Promise<Record<string, number>> {
    try {
      const raw = await kv.getItem(detailIndexKey(table));
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  async function flushDetailAsync(): Promise<void> {
    if (detailWriteTimer) {
      clearTimeout(detailWriteTimer);
      detailWriteTimer = null;
    }
    if (pendingDetailWrites.size === 0) return;
    const batch = Array.from(pendingDetailWrites.entries());
    pendingDetailWrites.clear();
    for (const [tableName, byKey] of batch) {
      const detail = detailTables[tableName];
      if (!detail) continue;
      const index = await readIndex(tableName);
      for (const [key, value] of byKey) {
        const stamp = detailStamp(tableName, value);
        put(detailKey(tableName, key), { value, latestTimestamp: stamp } satisfies DetailRecord);
        index[key] = stamp;
      }
      // Prune past cap/TTL — the index carries only stamps, so this never
      // deserializes payloads.
      const maxRows = detail.maxRows ?? DEFAULT_DETAIL_MAX_ROWS;
      const ttlMs = detail.ttlMs ?? DEFAULT_DETAIL_TTL_MS;
      const now = Date.now();
      const alive = Object.entries(index).sort((a, b) => b[1] - a[1]);
      const doomed: string[] = [];
      alive.forEach(([key, stamp], i) => {
        if (byKey.has(key)) return; // just written — always protected
        if (i >= maxRows || now - stamp > ttlMs) doomed.push(key);
      });
      for (const key of doomed) {
        delete index[key];
        kv.removeItem(detailKey(tableName, key)).catch(() => {});
      }
      put(detailIndexKey(tableName), index);
    }
  }

  function flushDetail(): void {
    void flushDetailAsync();
  }

  async function loadDetail(tableName: string, key: string): Promise<DetailRecord | null> {
    const buffered = pendingDetailWrites.get(tableName)?.get(key);
    if (buffered !== undefined) {
      return { value: buffered, latestTimestamp: detailStamp(tableName, buffered) };
    }
    try {
      const raw = await kv.getItem(detailKey(tableName, key));
      return raw ? (JSON.parse(raw) as DetailRecord) : null;
    } catch {
      return null;
    }
  }

  function writeDetail(tableName: string, key: string, value: any): void {
    if (hydrating) return;
    if (!detailTables[tableName]) return;
    let byKey = pendingDetailWrites.get(tableName);
    if (!byKey) pendingDetailWrites.set(tableName, (byKey = new Map()));
    byKey.set(key, value);
    if (!detailWriteTimer) detailWriteTimer = setTimeout(flushDetail, DETAIL_WRITE_DEBOUNCE_MS);
  }

  // -- Dispatch outbox --

  // One JSON array under a single key; a promise chain serializes writers so
  // concurrent enqueue/remove can't lose updates. Real promises are returned:
  // the middleware watchdog observes commit/failure.
  let outboxChain: Promise<unknown> = Promise.resolve();

  function withOutbox<T>(fn: (entries: OutboxEntry[]) => { next: OutboxEntry[]; result: T }): Promise<T> {
    const run = outboxChain.then(async () => {
      let entries: OutboxEntry[] = [];
      try {
        const raw = await kv.getItem(outboxKey);
        if (raw) entries = JSON.parse(raw) as OutboxEntry[];
      } catch {}
      const { next, result } = fn(entries);
      await kv.setItem(outboxKey, JSON.stringify(next));
      return result;
    });
    // The chain absorbs failures so one bad write can't wedge every later one;
    // the caller's returned promise still rejects.
    outboxChain = run.catch(() => {});
    return run;
  }

  function enqueueDispatch(entry: OutboxEntry): Promise<void> {
    return withOutbox((entries) => ({
      next: [...entries.filter((e) => e.id !== entry.id), entry],
      result: undefined,
    }));
  }

  function removeDispatch(id: string): Promise<void> {
    return withOutbox((entries) => ({
      next: entries.filter((e) => e.id !== id),
      result: undefined,
    }));
  }

  async function loadOutbox(): Promise<OutboxEntry[]> {
    try {
      const raw = await kv.getItem(outboxKey);
      if (!raw) return [];
      return (JSON.parse(raw) as OutboxEntry[]).sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    }
  }

  async function purgeLocalCache(): Promise<void> {
    pendingDetailWrites.clear();
    dirty.clear();
    shadow.clear();
    const removals: Promise<void>[] = [];
    for (const key of collectionKeys) removals.push(kv.removeItem(collectionKey(key)));
    for (const key of metaKeys) removals.push(kv.removeItem(metaKey(key)));
    removals.push(kv.removeItem(outboxKey));
    for (const table of Object.keys(detailTables)) {
      const index = await readIndex(table);
      for (const key of Object.keys(index)) removals.push(kv.removeItem(detailKey(table, key)));
      removals.push(kv.removeItem(detailIndexKey(table)));
    }
    await Promise.all(removals.map((p) => p.catch(() => {})));
  }

  // App-background / teardown hook: push everything buffered to disk now.
  function flushAll(): void {
    flushCollections();
    flushDetail();
  }

  return {
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
    flushAll,
  };
}
