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
  isPersistedClientStoreKey,
} from "./clientSyncRegistry";
import { diffCollection } from "./idbCollectionDiff";

let Storage: any = null;
try {
  Storage = require("expo-sqlite/kv-store").default;
} catch {
  Storage = null;
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
const OUTBOX_KEY = "dispatchOutbox";

let _hydrating = false;

// What each collection currently holds on disk, by id → row reference. The KV
// engine stores a collection as a single JSON blob, so it can't rewrite one row
// — but it CAN skip the rewrite entirely when a sync changed nothing (the common
// case: live queries re-push identical rows constantly). Seeded from loadCache.
const lastPersisted = new Map<string, Map<string, any>>();

// Test hook — see idbCache.ts.
export function _resetPersistedShadow() {
  lastPersisted.clear();
}

// False when the ExpoSQLite native module is absent (OTA shipped to an older
// binary). inboxStore gates its hydrate/persist wiring on this, so the app runs
// in-memory instead of crashing. Every Storage access below is also individually
// null-guarded as defense in depth.
export const PERSISTENCE_AVAILABLE = Storage != null;

// A top-level store key is durable iff it maps to a dedicated collection or is
// whitelisted as a meta blob. Keys that satisfy neither are silently dropped on
// write — the class of bug that lost pending user messages.
export function isPersistedStoreKey(key: string): boolean {
  return isPersistedClientStoreKey(key);
}

export function writePatchesToIDB(patches: Patch[], state: any) {
  if (!Storage || _hydrating) return;

  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  for (const key of affectedKeys) {
    if (COLLECTION_TABLES.has(key)) {
      const data = state[key];
      if (data && typeof data === "object") {
        const prevShadow = lastPersisted.get(key);
        const { puts, deletes: rawDeletes, next } = diffCollection(prevShadow, data);
        // NEVER wipe the cache from a store-shrink (same guarantee as the web
        // engine). A row leaves storage ONLY when explicitly removed — kill/archive
        // plant a `${key}:${id}` exclude in `pending`. A diff-delete with NO exclude
        // means the store is merely missing the row, so keep it in the persisted
        // blob AND the shadow. Makes a whole-collection wipe structurally impossible.
        const pending = (state.pending || {}) as Record<string, { type?: string }>;
        const kept: any[] = [];
        for (const id of rawDeletes) {
          if (pending[`${key}:${id}`]?.type === "exclude") continue; // intentional → drop
          if (prevShadow?.has(id)) { next.set(id, prevShadow.get(id)); kept.push(prevShadow.get(id)); }
        }
        lastPersisted.set(key, next);
        // Whole-blob engine: rewrite only when something actually changed, and
        // include the rows we refused to drop so they survive on disk.
        if (puts.length || rawDeletes.length) {
          const rows = kept.length ? [...Object.values(data), ...kept] : Object.values(data);
          Storage.setItem(COLLECTION_PREFIX + key, JSON.stringify(rows)).catch(() => {});
        }
      }
    } else if (META_KEYS.has(key)) {
      Storage.setItem(META_PREFIX + key, JSON.stringify(state[key])).catch(() => {});
    }
  }
}

export async function loadCache(): Promise<Record<string, any> | null> {
  if (!Storage) return null;
  try {
    const result: Record<string, any> = {};
    let hasData = false;

    const collectionKeys = [...COLLECTION_TABLES];
    const metaKeys = [...META_KEYS];
    const pairs = await Storage.multiGet([
      ...collectionKeys.map((k) => COLLECTION_PREFIX + k),
      ...metaKeys.map((k) => META_PREFIX + k),
    ]);
    const byKey = new Map(pairs);

    for (const key of collectionKeys) {
      const raw = byKey.get(COLLECTION_PREFIX + key);
      if (raw == null) continue;
      const rows = JSON.parse(raw) as any[];
      // Seed the persistence shadow with what's on disk so the first write after
      // hydrate diffs against reality (see idbCache.ts).
      const shadow = new Map<string, any>();
      if (rows.length > 0) {
        const map: Record<string, any> = {};
        for (const row of rows) { map[row._id] = row; shadow.set(row._id, row); }
        result[key] = map;
        hasData = true;
      }
      lastPersisted.set(key, shadow);
    }

    for (const key of metaKeys) {
      const raw = byKey.get(META_PREFIX + key);
      if (raw == null) continue;
      result[key] = JSON.parse(raw);
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

export async function loadConversationMessages(convId: string): Promise<{ messages: any[]; pagination: any; latestTimestamp: number } | null> {
  if (!Storage) return null;
  try {
    const raw = await Storage.getItem(CONVMSG_PREFIX + convId);
    if (raw == null) return null;
    const row = JSON.parse(raw);
    return { messages: row.messages, pagination: row.pagination, latestTimestamp: row.latestTimestamp };
  } catch {
    return null;
  }
}

export function writeConversationMessages(convId: string, messages: any[], pagination: any) {
  if (!Storage || _hydrating) return;
  const latestTimestamp = messages.length > 0
    ? Math.max(...messages.map((m: any) => m.timestamp || 0))
    : 0;
  Storage.setItem(CONVMSG_PREFIX + convId, JSON.stringify({ messages, pagination, latestTimestamp })).catch(() => {});
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
