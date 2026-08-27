// Hydration-time retention policy for the persisted caches, shared by both
// persistence engines (web Dexie idbCache.ts + native kv-store
// idbCache.native.ts) the same way idbCollectionDiff is. The generic partition
// and tombstone expiry live in @platform/engine (cacheRetention / idbCache
// there); this module injects codecast's session-shaped policy.
import {
  partitionCacheRetention,
  deriveRegistryMaps,
  expireExcludeTombstones as engineExpireExcludeTombstones,
} from "@platform/engine";
import { isConvexId } from "../lib/entityLinks";
import { CLIENT_SYNC_REGISTRY } from "./clientSyncRegistry";

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
export const SESSION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // mirrors DISMISS_RECONCILE_WINDOW_MS / the server crawl window
export const MAX_CACHED_SESSIONS = 1200;

export function partitionSessionRetention(
  rows: any[],
  liveInboxIdList: string[] | undefined,
  lastFocusedId: string | null | undefined,
  now: number,
): { keep: any[]; drop: string[] } {
  const liveIds = new Set(liveInboxIdList ?? []);
  return partitionCacheRetention(rows, now, {
    ttlMs: SESSION_CACHE_TTL_MS,
    maxRows: MAX_CACHED_SESSIONS,
    alwaysKeep: (row) =>
      liveIds.has(row._id) || row._id === lastFocusedId || !isConvexId(row._id) || !!row.is_pinned,
    stampedAt: (row) =>
      Math.max(row.updated_at ?? 0, row._creationTime ?? 0, row.inbox_stashed_at ?? 0, row.inbox_dismissed_at ?? 0),
    sortStamp: (row) => row.updated_at ?? 0,
  });
}

// Retention for the persisted docDetails collection (doc bodies + detail
// joins), applied at hydration. Rows enter only when a doc is OPENED (the
// detail query) or body-prefetched for the recent list page, so growth tracks
// what the user actually reads — but nothing ever removed rows, and bodies are
// the heavy bytes the thin `docs` list cache deliberately sheds. Cap by
// last-open recency (`_cachedAt`, stamped by the sync hook) with the doc's own
// updated_at as the fallback for rows from older builds. A dropped body stays
// one round-trip away: opening the doc re-fetches and re-seeds it.
export const DOC_DETAIL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CACHED_DOC_DETAILS = 200;

export function partitionDocDetailRetention(
  rows: any[],
  now: number,
): { keep: any[]; drop: string[] } {
  return partitionCacheRetention(rows, now, {
    ttlMs: DOC_DETAIL_CACHE_TTL_MS,
    maxRows: MAX_CACHED_DOC_DETAILS,
    alwaysKeep: (row) => !isConvexId(row._id) || !!row.pinned,
    stampedAt: (row) => Math.max(row._cachedAt ?? 0, row.updated_at ?? 0),
    sortStamp: (row) => Math.max(row._cachedAt ?? 0, row.updated_at ?? 0),
  });
}

// Exclude tombstones never clear for delta tables (absence ≠ deletion in
// applySyncTable), so every kill/dismiss adds a permanent `pending` entry —
// measured at 1,832 entries after a heavy agent fan-out, and each one rides
// every sync push and every persisted pending blob. A tombstone only matters
// while the server could still resend the row, which is bounded by the same
// 30d window as the cache retention above — age them out at hydration. Legacy
// entries without a timestamp get stamped `now` and age out one window later.
// include/field entries are local-first writes awaiting server acknowledgment:
// never expired — except field locks on fields the registry declares
// unprotected (tasks.comments), which no current build can create; stale ones
// persisted by older builds would override every server push forever.
const { isUnprotectedField } = deriveRegistryMaps(CLIENT_SYNC_REGISTRY as any);

export function expireExcludeTombstones(
  pending: Record<string, any>,
  now: number,
): Record<string, any> {
  return engineExpireExcludeTombstones(pending, now, SESSION_CACHE_TTL_MS, isUnprotectedField);
}
