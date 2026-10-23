// The sync watermark keys, in a leaf that imports nothing: the crawl, the
// inbox floor and the store's own first-run reading (store/firstRunState.ts)
// all name a watermark the same way without the store importing its feeders.

// Single source of truth for the per-workspace watermark key. BOTH the crawl
// (reconcileCrawl) and the live channel (useSyncTasks) must read/write the SAME key or the
// two would track divergent watermarks. The `:v2` segment forces a one-time full
// re-backfill for every client: pre-fix crawls could persist a watermark on an
// INCOMPLETE / pruned cache, after which only incremental top-ups ran and the gaps
// never refilled. Bump a namespace's segment to abandon its old watermarks and force
// one full backfill of that namespace alone. It is additive, since the never-clear
// guard FILLS the cache without wiping it.
//
// tasks is at v3 since `cause` became a deep field (2026-10-23): until then the
// store kept the held row whenever no scalar moved, so every write to `cause` that
// leaves updated_at alone (scores and families, titles, names, merges) was dropped
// on arrival, and only a full crawl brings those rows back.
const WATERMARK_VERSION: Record<string, number> = { tasks: 3 };

export function syncMetaKey(namespace: string, wsKey: string): string {
  return `${namespace}:v${WATERMARK_VERSION[namespace] ?? 2}:${wsKey}`;
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
