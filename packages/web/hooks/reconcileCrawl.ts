import { useInboxStore } from "../store/inboxStore";

// Shared full-reconcile crawl, used by useSyncTasks and useSyncDocs.
//
// Both hooks need the same thing: page through EVERY row in the workspace once
// (one-shot `convex.query()` calls — NOT live subscriptions, so the crawl never
// recreates the per-page subscription storm that saturated the backend),
// overlaying each page as a delta so the list visibly streams in, then a final
// delta re-overlay of the full set. Both phases are ADDITIVE — the crawl never
// prunes; deletions arrive as deltas (status changes) hidden by read-time
// filters, so a short / truncated crawl can never gut the cache.
//
// Crawl lifecycle is managed at MODULE scope (not React effect cleanup): the
// effects re-run frequently (WS reconnect / project-path flicker) and cancelling
// the in-flight crawl on every re-render meant it never finished. State is keyed
// by `namespace` so tasks and docs throttle independently.
//   doneAt     — wsKey → last SUCCESSFUL completion (throttle window).
//   runningKey — wsKey of the crawl currently in flight, if any.
//   gen        — bumped on a real workspace change so a stale crawl abandons its
//                writes instead of clobbering the new workspace's data.
type ReconcileState = { doneAt: Map<string, number>; runningKey: string | null; gen: number };
const states = new Map<string, ReconcileState>();
function stateFor(namespace: string): ReconcileState {
  let s = states.get(namespace);
  if (!s) { s = { doneAt: new Map(), runningKey: null, gen: 0 }; states.set(namespace, s); }
  return s;
}

function setProgress(namespace: string, loading: boolean, loaded: number) {
  const prev = useInboxStore.getState().syncProgress;
  useInboxStore.setState({ syncProgress: { ...prev, [namespace]: { loading, loaded } } });
}

export type CrawlPage = { rows: any[]; isDone: boolean; continueCursor: string | null };

export type CrawlOptions = {
  /** Throttle/progress key — also the store scope the badge reads ("tasks" | "docs"). */
  namespace: string;
  /** Workspace identity. "skip" is a no-op (no active workspace yet). */
  wsKey: string;
  throttleMs: number;
  pageDelayMs: number;
  maxPages: number;
  /** Fetch one page given the previous page's cursor (null for the first page). */
  fetchPage: (cursor: string | null) => Promise<CrawlPage>;
  /** Overlay a freshly-fetched page (delta — never prunes). */
  onPage: (rows: any[]) => void;
  /**
   * Final overlay of the full set. `complete` is true only when the crawl
   * reached the true end (isDone / no next cursor), false when it stopped at
   * `maxPages` with more rows unfetched. Additive overlays (tasks/docs/sessions)
   * ignore it; a consumer that PRUNES on this pass (the dismiss reconcile's
   * CLEAR) must gate on `complete` so a truncated crawl can't drop real rows.
   */
  onComplete: (all: any[], complete: boolean) => void;
  /**
   * Ignore the DURABLE watermark on the first run of a page session — see
   * crawlThrottledAt. Set on the hidden-set crawls (dismissed / stashed) only.
   */
  bootEager?: boolean;
};

/**
 * The skip decision, extracted so it's unit-testable without the async crawl.
 *
 * Normally the throttle honors BOTH watermarks: the module-scope `doneAt` (this
 * page session) and the persisted `backfilledAt` (durable across reloads), so a
 * relaunch inside the window serves the IDB cache instead of re-walking the table.
 *
 * `bootEager` consults ONLY the in-session mark. It exists for the "dismissed" /
 * "stashed" crawls, which are the sole channel that heals cross-device dismissal
 * state: a dismiss/kill doesn't move updated_at, so neither the live channel nor
 * the sessions crawl carries it to a client that was asleep. With the durable
 * throttle, a client reloading on a stale cache showed resurrected killed sessions
 * for up to the full 30-minute SESSIONS_RECONCILE_THROTTLE_MS — reloading, the
 * user's natural fix, could not clear them.
 *
 * This is not free, and the cost is per WINDOW LOAD, not per user: each eager pass
 * is a full 30-day index range scan of the hidden set — one for `dismissed`, one
 * for `stashed` — paged at 1000 rows. The rows are narrow ({_id, timestamp}) and
 * the scans are bounded by DISMISS_RECONCILE_WINDOW_MS rather than table size, but
 * a user who reloads often, or runs several tabs, pays two scans every time where
 * they previously paid none. We take that trade deliberately: a resurrected killed
 * session is a correctness bug the user cannot clear by any means available to
 * them, and read amplification on a windowed index is the cheaper failure.
 *
 * The in-session mark still gates repeats: the effect behind these crawls re-fires
 * on wsKey settle and every reconcileNonce tick, and once the first crawl completes
 * `st.doneAt` is set, so bootEager throttles identically from then on — the eager
 * pass happens once per page load, not on every re-render.
 */
export function crawlThrottledAt(
  now: number,
  throttleMs: number,
  sessionDoneAt: number,
  persistedDoneAt: number,
  bootEager: boolean,
): boolean {
  const lastDoneAt = bootEager ? sessionDoneAt : Math.max(sessionDoneAt, persistedDoneAt);
  return now - lastDoneAt < throttleMs;
}

/**
 * Whether the boot-eager bypass may be armed yet.
 *
 * The eager crawl's CLEAR pass un-hides any row inside the window the server's
 * hidden set omits — so it must not run on a PRE-REPLAY view of the server. The
 * losing interleaving: the user kills a session while offline, the dispatch parks
 * in the durable outbox, and `pending`'s field lock is persisted with its original
 * timestamp. They reload more than HIDDEN_OVERRIDE_SETTLE_MS (5 min) later, so
 * lockedLocal treats the override as stale and releases it — deliberately, that
 * release is what stops an originating device pinning a row hidden forever. If the
 * eager crawl's pages are fetched before the outbox replay lands, the server hasn't
 * been told about the kill, the CLEAR pass un-hides it, and the killed session
 * climbs back into the inbox until the next crawl up to 30 minutes later.
 *
 * The durable throttle used to mask this: a reload inside 30 minutes skipped the
 * boot crawl entirely and let the outbox drain first. Boot-eager removes that
 * accident, so we reinstate the ordering on purpose — hold the bypass until the
 * boot replay has attempted every parked entry.
 *
 * `maxWaitMs` bounds the wait: an outbox that never settles (no dispatch binding,
 * a wedged drain) must not disable the healing crawl forever. Waiting is also
 * self-limiting in the case that matters — if the outbox is stuck because the
 * client is offline, the crawl's own queries fail anyway, so the ordering is moot.
 * Until this returns true the caller simply passes bootEager: false, which falls
 * back to the durable throttle — the exact, safe pre-change behavior.
 */
export function bootEagerArmed(bootOutboxDrained: boolean, waitedMs: number, maxWaitMs: number): boolean {
  return bootOutboxDrained || waitedMs >= maxWaitMs;
}

/**
 * Kick off a reconcile crawl if one isn't already running / recently done for
 * this workspace. Fire-and-forget: returns immediately, runs in the background,
 * and publishes progress to `syncProgress[namespace]`.
 */
// Single source of truth for the per-workspace watermark key. BOTH the crawl
// (here) and the live channel (useSyncTasks) must read/write the SAME key or the
// two would track divergent watermarks. The `:v2` segment forces a one-time full
// re-backfill for every client: pre-fix crawls could persist a watermark on an
// INCOMPLETE / pruned cache, after which only incremental top-ups ran and the gaps
// never refilled. Bump this segment to abandon old watermarks and force one full
// backfill — additive, since the never-clear guard FILLS the cache without wiping it.
export function syncMetaKey(namespace: string, wsKey: string): string {
  return `${namespace}:v2:${wsKey}`;
}

export function runReconcileCrawl(opts: CrawlOptions): void {
  const { namespace, wsKey, throttleMs, pageDelayMs, maxPages } = opts;
  if (wsKey === "skip") return;
  const st = stateFor(namespace);
  const metaKey = syncMetaKey(namespace, wsKey);
  // Recently completed for this workspace → serve from the IDB-cached store.
  // The completion time is DURABLE (persisted in syncMeta), so a fresh page load
  // honors a backfill that finished in a prior session instead of re-crawling the
  // whole table on every launch. The module-scope doneAt covers the in-session case,
  // and is the ONLY mark bootEager consults — see crawlThrottledAt.
  const persistedDoneAt = useInboxStore.getState().syncMeta[metaKey]?.backfilledAt ?? 0;
  if (crawlThrottledAt(Date.now(), throttleMs, st.doneAt.get(wsKey) ?? 0, persistedDoneAt, !!opts.bootEager)) return;
  // A crawl for THIS workspace is already in flight → let it finish.
  if (st.runningKey === wsKey) return;

  // Start (and supersede any crawl for a different/old workspace).
  const myGen = ++st.gen;
  st.runningKey = wsKey;
  const superseded = () => st.gen !== myGen;

  (async () => {
    setProgress(namespace, true, 0);
    const all: any[] = [];
    let cursor: string | null = null;
    let completed = false; // reached the true end vs stopped at maxPages
    const seenCursors = new Set<string>();
    for (let i = 0; i < maxPages; i++) {
      // Retry transient page failures with backoff — one hiccup must not abandon
      // the whole crawl and leave a partial list. Give up only after several tries.
      let page: CrawlPage | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (superseded()) return;
        try { page = await opts.fetchPage(cursor); break; }
        catch {
          if (attempt === 4) {
            // Persistent failure: don't snapshot a partial set (it would prune
            // real rows). Leave overlaid pages in place; retry next effect run.
            if (!superseded()) { st.runningKey = null; setProgress(namespace, false, all.length); }
            return;
          }
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
      if (superseded() || !page) return; // a newer workspace crawl took over
      const rows = page.rows ?? [];
      all.push(...rows);
      // Overlay each page immediately so the list fills in progressively.
      if (rows.length) opts.onPage(rows);
      // Convex paginate may return short/empty pages mid-stream (rows can be 0
      // while more remain) — only isDone marks the true end. seenCursors is a
      // belt-and-braces guard against a cursor that never advances.
      const next = page.continueCursor || null;
      const more = !page.isDone && !!next && !seenCursors.has(next);
      setProgress(namespace, more, all.length);
      if (!more) { completed = true; break; }
      seenCursors.add(next!);
      cursor = next;
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }
    if (superseded()) return;
    // Final completeness pass: re-overlay the full set. onComplete is a DELTA
    // overlay (the big collections are isDelta in SYNC_REGISTRY) — additive, never
    // prunes — so this only fills in rows onPage may have missed. Deletions arrive
    // as deltas, never by snapshot, so a short/truncated crawl can't gut the cache.
    // `completed` lets a pruning consumer (the dismiss CLEAR) know the set is whole.
    opts.onComplete(all, completed);
    // Persist the watermark: backfilledAt (durable throttle — skip the crawl on
    // the next launch) and cursor = the highest updated_at we just saw (so the
    // NEXT crawl resumes incrementally from here via `since`). cursor advances
    // forward-only in recordSyncMeta, so an empty incremental pass can't rewind it.
    const now = Date.now();
    let maxUpdated = 0;
    for (const r of all) {
      const u = (r as any)?.updated_at;
      if (typeof u === "number" && u > maxUpdated) maxUpdated = u;
    }
    useInboxStore.getState().recordSyncMeta(metaKey, { backfilledAt: now, cursor: maxUpdated || undefined });
    setProgress(namespace, false, all.length);
    st.doneAt.set(wsKey, now);
    st.runningKey = null;
  })();
}
