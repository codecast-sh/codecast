import { PENDING_JOURNAL_PREFIX } from "./pendingMessageJournal";
import { COLLECTION_STORE_KEYS, META_STORE_KEYS } from "./clientSyncRegistry";

// The native cache's key scheme over kv-store's flat `storage` table, and the
// reads and purges planned over it. Pure: idbCache.native owns the I/O.

export const COLLECTION_TABLES = new Set<string>(COLLECTION_STORE_KEYS);
export const META_KEYS = new Set<string>(META_STORE_KEYS);

// KV key prefixes namespace the flat store so reads can reconstruct the same
// shape Dexie's per-table layout produces.
export const COLLECTION_PREFIX = "col:";
export const META_PREFIX = "meta:";
export const CONVMSG_PREFIX = "convmsg:";
export const CONVUSERMSG_PREFIX = "convusermsg:";
export const OUTBOX_KEY = "dispatchOutbox";
export const PENDING_INPUT_PREFIX = "pendingInput:v1:";

// The split feeder's held rows (hooks/useSplitQuery), one key per row holding
// the server's hash for it and the row: "<hash>\n<json>". With them on disk a
// relaunch rebuilds the first split result instead of downloading the whole
// inbox and hashing every row of it again. Every rebuild is still checked
// against the server's hash, so a stale or foreign row only costs that fetch.
export const SPLIT_PREFIX = "split:v1:";

// conversations is registered as a meta blob (one JSON object) so web Dexie
// can store it in the meta table. On native that blob is the sessions twin:
// creating a session stringified the whole map on the JS thread and froze
// the send button on a new session. Persist it per-row like collections.
export const PER_ROW_META_KEYS = new Set(["conversations"]);

export function collectionBlobKey(key: string): string {
  return COLLECTION_PREFIX + key;
}

export function collectionRowKey(key: string, id: string): string {
  return COLLECTION_PREFIX + key + ":" + id;
}

export function isCollectionRowKey(storageKey: string, collectionKey: string): boolean {
  return storageKey.startsWith(COLLECTION_PREFIX + collectionKey + ":");
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

export function rowsToMap(rows: { key: string; value: string | null }[]): Map<string, string | null> {
  const byKey = new Map<string, string | null>();
  for (const row of rows) byKey.set(row.key, row.value);
  return byKey;
}

/** readPlan over a key listing, for the per-key path when SQL is not there. */
export function collectReadKeys(allKeys: string[], wanted: Set<string> | null): string[] {
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

// The kv-store database is shared (the push catch-up watermark lives in it
// too), so ownership checks and purges cover only the keys idbCache.native writes.
function ownedKeyPrefixes(): string[] {
  return [COLLECTION_PREFIX, META_PREFIX, CONVMSG_PREFIX, CONVUSERMSG_PREFIX, SPLIT_PREFIX, PENDING_INPUT_PREFIX, PENDING_JOURNAL_PREFIX];
}

/** A key the native cache wrote, outside `keepPrefix`. */
export function isPurgeable(key: string, keepPrefix: string | null): boolean {
  if (keepPrefix && key.startsWith(keepPrefix)) return false;
  return key === OUTBOX_KEY || ownedKeyPrefixes().some((prefix) => key.startsWith(prefix));
}

/** isPurgeable as a SQL condition over kv-store's `storage` table. */
export function ownedKeysWhere(keepPrefix: string | null): { where: string; params: Array<string | number> } {
  const prefixes = ownedKeyPrefixes();
  const owned = [...prefixes.map(() => "substr(key, 1, ?) = ?"), "key = ?"].join(" OR ");
  const params: Array<string | number> = [...prefixes.flatMap((p) => [p.length, p]), OUTBOX_KEY];
  if (!keepPrefix) return { where: `(${owned})`, params };
  return { where: `(${owned}) AND substr(key, 1, ?) <> ?`, params: [...params, keepPrefix.length, keepPrefix] };
}
