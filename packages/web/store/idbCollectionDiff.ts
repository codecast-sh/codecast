// Incremental persistence diff for the IDB collection caches (web Dexie +
// native kv-store). The generic algorithm lives in @platform/engine
// (idbCollectionDiff there) and is re-exported here; what this module adds is
// codecast's rule for which of the diff's deletes may reach disk, shared by
// both persistence engines.
import { isConvexId } from "../lib/entityLinks";
import { COLLECTION_STORE_KEYS } from "./clientSyncRegistry";

export { diffCollection, type CollectionDiff } from "@platform/engine";

// ── Which diff-deletes may reach disk ────────────────────────────────────────
// A row leaving the in-memory store is NOT, by itself, a reason to delete it
// from disk: a windowed payload, a paused hydration or a bug all shrink the
// store while the row is healthy on the server. Three things do authorize the
// delete, and both persistence engines (web Dexie, native kv-store) apply this
// one rule:
//   • an exclude in `pending` — an explicit local removal (kill, archive);
//   • a client-minted stub id — no server window or paused hydration explains
//     its absence, so it is always an intentional local removal (the altKey
//     supersede, a create rollback). Protecting stubs kept every sent message's
//     stub on disk; hydration then resurrected it NEXT TO its server twin and
//     the transcript showed each of your own messages twice;
//   • a SNAPSHOT prune — a non-delta sync is the server's complete set, so a
//     row it omits is gone. Without this the prune only ever reached memory:
//     the row stayed on disk, and the next boot's hydration put it back with
//     its last cached fields until the following push dropped it again. That
//     was a decision handed to a teammate flashing back as "pending, asked:
//     you" on every load, and 435 decision rows on disk for a query that
//     returns a few dozen.
// The ledger is module state, not store state: it authorizes a disk write and
// nothing renders from it. Deliberately NOT an exclude tombstone — a tombstone
// outlives the push that planted it and hides the row if the server sends it
// again (a session handed back), which a plain replace never does.
const snapshotDrops = new Map<string, Set<string>>();
const landedSnapshots = new Set<string>();
// Only a collection with a disk table ever spends a drop; recording the rest
// would grow the ledger for the life of the page.
const persistedCollections: ReadonlySet<string> = new Set(COLLECTION_STORE_KEYS);

/** A non-delta sync landed for `key`: `incomingIds` is the server's complete set. */
export function noteSnapshotSync(key: string, incomingIds: Iterable<string>, droppedIds: Iterable<string>): void {
  if (!persistedCollections.has(key)) return;
  landedSnapshots.add(key);
  let drops = snapshotDrops.get(key);
  // A row the server sends again is no longer dropped.
  if (drops) for (const id of incomingIds) drops.delete(id);
  for (const id of droppedIds) {
    if (!drops) snapshotDrops.set(key, (drops = new Set()));
    drops.add(id);
  }
}

/**
 * The cached rows that may still land under a live value at hydration. Until a
 * snapshot has landed the cache is the floor (unionHydrate's windowed-payload
 * rationale). Once one has, the live value IS the complete server set: a cached
 * server row it omits is gone, so only client-minted stubs survive — and the
 * omitted rows are noted so the next write clears them from disk.
 */
export function cacheFloorUnderSnapshot<T>(
  key: string,
  cached: Record<string, T>,
  live: Record<string, T> | undefined,
): Record<string, T> {
  if (!landedSnapshots.has(key)) return cached;
  const floor: Record<string, T> = {};
  const gone: string[] = [];
  for (const id in cached) {
    if (!isConvexId(id)) floor[id] = cached[id];
    else if (!live || !(id in live)) gone.push(id);
  }
  if (gone.length) noteSnapshotSync(key, [], gone);
  return floor;
}

/** Filter a diff's deletes to the ones allowed on disk; kept rows stay in `next`. */
export function durableDeletes(
  key: string,
  rawDeletes: readonly string[],
  pending: Record<string, { type?: string } | undefined>,
  prevShadow: Map<string, any> | undefined,
  next: Map<string, any>,
): string[] {
  const drops = snapshotDrops.get(key);
  const deletes: string[] = [];
  for (const id of rawDeletes) {
    if (pending[`${key}:${id}`]?.type === "exclude" || !isConvexId(String(id)) || drops?.has(id)) {
      deletes.push(id);
    } else if (prevShadow?.has(id)) {
      next.set(id, prevShadow.get(id));
    }
  }
  // One write settles the collection: the shadow mirrors disk, so a noted id
  // this diff did not name was never on disk. Spent or moot, the drops go.
  snapshotDrops.delete(key);
  return deletes;
}

/** Collections holding drops no write has spent yet (see the post-hydration flush). */
export function keysWithSnapshotDrops(): string[] {
  return [...snapshotDrops].filter(([, ids]) => ids.size > 0).map(([key]) => key);
}

export function _resetSnapshotLedger(): void {
  snapshotDrops.clear();
  landedSnapshots.clear();
}
