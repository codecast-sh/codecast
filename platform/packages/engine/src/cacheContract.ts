// The persistence contract and the pure retention rule, with no backing
// store. idbCache.ts adds the Dexie implementation for the web; idbCache.native.ts
// re-exports this file for Metro, so a phone bundle never carries Dexie.
import type Dexie from "dexie";
import type { Patch } from "mutative";
import type { OutboxEntry } from "./types";

export const PERSISTENCE_AVAILABLE = typeof window !== "undefined" && typeof indexedDB !== "undefined";

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

