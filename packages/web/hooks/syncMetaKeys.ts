// The sync watermark keys, in a leaf that imports nothing: the crawl, the
// inbox floor and the store's own first-run reading (store/firstRunState.ts)
// all name a watermark the same way without the store importing its feeders.

// Single source of truth for the per-workspace watermark key. BOTH the crawl
// (reconcileCrawl) and the live channel (useSyncTasks) must read/write the SAME key or the
// two would track divergent watermarks. The `:v2` segment forces a one-time full
// re-backfill for every client: pre-fix crawls could persist a watermark on an
// INCOMPLETE / pruned cache, after which only incremental top-ups ran and the gaps
// never refilled. Bump this segment to abandon old watermarks and force one full
// backfill. It is additive, since the never-clear guard FILLS the cache without wiping it.
export function syncMetaKey(namespace: string, wsKey: string): string {
  return `${namespace}:v2:${wsKey}`;
}

/** The inbox floor's workspace key for one principal. */
export function inboxCrawlWsKey(principalId: string | null | undefined): string {
  return principalId ? `inbox:${principalId}` : "skip";
}

/** The floor has been cut for this principal: every session in the horizon
 *  is in the cache, so an empty cache means there are none (store/firstRunState.ts). */
export function inboxFloorStamped(s: { syncMeta: Record<string, { backfilledAt?: number } | undefined> }, principalId: string | null | undefined): boolean {
  return !!s.syncMeta[syncMetaKey("sessions", inboxCrawlWsKey(principalId))]?.backfilledAt;
}
