// Hydration-time retention policy for a persisted collection cache, shared by
// every persistence engine (web IDB + native kv-store) the same way
// idbCollectionDiff is. Pure functions only — each engine owns how the pruned
// result reaches its own disk.
//
// Why it exists: an in-memory collection the UI holds refs into must never
// prune mid-session, which makes the on-disk cache append-only across months.
// A long-lived install was measured hydrating ~7,000 rows into a map whose
// live view renders ~134 — and every O(N) pass (syncTable, wake signatures,
// grouping, sorting) paid the 7k price on each liveness flip, pinning the main
// thread. Boot is the one safe moment to shed that weight: nothing holds refs
// yet, and everything the UI can actually reach is kept. Anything older is
// dropped from memory AND disk; it stays reachable via search/deep-link, which
// re-fetch from the server and re-seed the cache.

export type CacheRetentionPolicy = {
  /** Age past which a row outside the always-keep set is dropped. */
  ttlMs: number;
  /** Cap on the TTL-window survivors (never the always-keep set), newest first. */
  maxRows: number;
  /**
   * Rows the UI can always reach — kept unconditionally and never counted
   * against maxRows (a server-authoritative live set, the restored focus
   * target, optimistic stubs the server can't restore, explicit pins).
   */
  alwaysKeep: (row: any) => boolean;
  /** Freshness stamp deciding TTL survival. */
  stampedAt: (row: any) => number;
  /** Stamp ordering the TTL-window survivors for the cap; defaults to stampedAt. */
  sortStamp?: (row: any) => number;
};

export function partitionCacheRetention(
  rows: any[],
  now: number,
  policy: CacheRetentionPolicy,
): { keep: any[]; drop: string[] } {
  const sortStamp = policy.sortStamp ?? policy.stampedAt;
  const pinnedKeep: any[] = [];
  const windowed: any[] = [];
  const drop: string[] = [];
  for (const row of rows) {
    if (policy.alwaysKeep(row)) {
      pinnedKeep.push(row);
    } else if (now - policy.stampedAt(row) <= policy.ttlMs) {
      windowed.push(row);
    } else {
      drop.push(row._id);
    }
  }
  // Cap the TTL-window survivors (never the always-keep set), newest first.
  if (windowed.length > policy.maxRows) {
    windowed.sort((a, b) => sortStamp(b) - sortStamp(a));
    for (const row of windowed.splice(policy.maxRows)) drop.push(row._id);
  }
  return { keep: pinnedKeep.concat(windowed), drop };
}
