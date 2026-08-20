// Hydration-time retention policy for the persisted caches, shared by both
// persistence engines (web Dexie idbCache.ts + native kv-store
// idbCache.native.ts) the same way idbCollectionDiff is. Pure functions only —
// each engine owns how the pruned result reaches its own disk.
import { isConvexId } from "../lib/entityLinks";

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
  const pinnedKeep: any[] = [];
  const windowed: any[] = [];
  const drop: string[] = [];
  for (const row of rows) {
    const stampedAt = Math.max(row.updated_at ?? 0, row._creationTime ?? 0, row.inbox_stashed_at ?? 0, row.inbox_dismissed_at ?? 0);
    if (liveIds.has(row._id) || row._id === lastFocusedId || !isConvexId(row._id) || row.is_pinned) {
      pinnedKeep.push(row);
    } else if (now - stampedAt <= SESSION_CACHE_TTL_MS) {
      windowed.push(row);
    } else {
      drop.push(row._id);
    }
  }
  // Cap the TTL-window survivors (never the always-keep set), newest first.
  if (windowed.length > MAX_CACHED_SESSIONS) {
    windowed.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    for (const row of windowed.splice(MAX_CACHED_SESSIONS)) drop.push(row._id);
  }
  return { keep: pinnedKeep.concat(windowed), drop };
}

// Exclude tombstones never clear for delta tables (absence ≠ deletion in
// applySyncTable), so every kill/dismiss adds a permanent `pending` entry —
// measured at 1,832 entries after a heavy agent fan-out, and each one rides
// every sync push and every persisted pending blob. A tombstone only matters
// while the server could still resend the row, which is bounded by the same
// 30d window as the cache retention above — age them out at hydration. Legacy
// entries without a timestamp get stamped `now` and age out one window later.
// include/field entries are local-first writes awaiting server acknowledgment:
// never expired.
export function expireExcludeTombstones(
  pending: Record<string, any>,
  now: number,
): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, entry] of Object.entries(pending)) {
    if (entry?.type === "exclude") {
      if (!entry.ts) { cleaned[key] = { ...entry, ts: now }; continue; }
      if (now - entry.ts > SESSION_CACHE_TTL_MS) continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}
