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

/** Abandon the active crawl in one namespace without affecting other crawls. */
export function cancelReconcileCrawl(namespace: string): void {
  const st = stateFor(namespace);
  st.gen++;
  st.runningKey = null;
  setProgress(namespace, false, 0);
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
  /** Dynamic lifecycle fence (principal changes, durable replay gates, etc.). */
  isCurrent?: () => boolean;
  /**
   * Final overlay of the full set. `complete` is true only when the crawl
   * reached the true end (isDone / no next cursor), false when it stopped at
   * `maxPages` with more rows unfetched. Additive overlays (tasks/docs/sessions)
   * ignore it; a consumer that PRUNES on this pass (the docs absent-prune)
   * must gate on `complete` so a truncated crawl can't drop real rows.
   */
  onComplete: (all: any[], complete: boolean, isCurrent: () => boolean) => void | Promise<void>;
  /** Ignore the durable watermark on the first run in this page session. */
  bootEager?: boolean;
};

/**
 * The skip decision, extracted so it's unit-testable without the async crawl.
 *
 * Normally the throttle honors BOTH watermarks: the module-scope `doneAt` (this
 * page session) and the persisted `backfilledAt` (durable across reloads), so a
 * relaunch inside the window serves the IDB cache instead of re-walking the table.
 *
 * `bootEager` consults ONLY the in-session mark: a crawl that must run once per
 * page load regardless of the durable watermark.
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

// Removal-condition metric for the demoted safety-net crawls (design D11/D12,
// docs/architecture/sync-log-migration.md): on an INCREMENTAL crawl, a returned
// row the store doesn't already hold at the same updated_at is a row the sync
// log failed to deliver (modulo benign races inside the crawl window). The
// hooks sum this per crawl and log it; two weeks of zeros in prod is the
// condition for deleting the periodic schedule. Pure — unit-testable.
export function countLogMissedRows(
  current: Record<string, any> | undefined,
  rows: any[],
): number {
  if (!current) return rows.length;
  let n = 0;
  for (const r of rows) {
    const cur = current[String(r?._id)];
    if (!cur || (typeof r?.updated_at === "number" && cur.updated_at !== r.updated_at)) n++;
  }
  return n;
}

export function runReconcileCrawl(opts: CrawlOptions): void {
  const { namespace, wsKey, throttleMs, pageDelayMs, maxPages } = opts;
  if (wsKey === "skip") {
    cancelReconcileCrawl(namespace);
    return;
  }
  if (opts.isCurrent && !opts.isCurrent()) return;
  const st = stateFor(namespace);
  const metaKey = syncMetaKey(namespace, wsKey);
  // Recently completed for this workspace → serve from the IDB-cached store.
  // The completion time is DURABLE (persisted in syncMeta), so a fresh page load
  // honors a backfill that finished in a prior session instead of re-crawling the
  // whole table on every launch. The module-scope doneAt covers the in-session case.
  const persistedDoneAt = useInboxStore.getState().syncMeta[metaKey]?.backfilledAt ?? 0;
  if (crawlThrottledAt(Date.now(), throttleMs, st.doneAt.get(wsKey) ?? 0, persistedDoneAt, !!opts.bootEager)) return;
  // A crawl for THIS workspace is already in flight → let it finish.
  if (st.runningKey === wsKey) return;

  // Start (and supersede any crawl for a different/old workspace).
  const myGen = ++st.gen;
  st.runningKey = wsKey;
  const superseded = () => st.gen !== myGen;
  const isCurrent = () => !superseded() && (opts.isCurrent?.() ?? true);
  const stop = (loaded: number) => {
    if (!superseded()) {
      st.runningKey = null;
      setProgress(namespace, false, loaded);
    }
  };

  // Resume checkpoint: a reload mid-crawl used to restart from page zero, so a
  // client that reloads more often than a full crawl takes NEVER finished — it
  // paid the whole table walk on every launch, forever. Each flush persists the
  // continuation cursor; a fresh launch inside the window picks up where the
  // interrupted crawl stopped (earlier pages already landed via their flushes).
  // A resumed run's `all` is only the tail, so it reports complete=false — a
  // pruning consumer (the dismiss CLEAR, docs' absent-prune) must never treat a
  // partial set as authoritative. True deletion reconcile happens on the next
  // un-resumed crawl after the throttle window.
  const RESUME_WINDOW_MS = 30 * 60 * 1000;
  const meta = useInboxStore.getState().syncMeta[metaKey];
  const resumeCursor =
    meta?.resumeCursor && Date.now() - (meta.resumeAt ?? 0) < RESUME_WINDOW_MS
      ? meta.resumeCursor
      : null;

  (async () => {
    setProgress(namespace, true, 0);
    const all: any[] = [];
    let cursor: string | null = resumeCursor;
    let resumedMidway = !!resumeCursor;
    let completed = false; // reached the true end vs stopped at maxPages
    const seenCursors = new Set<string>();
    // Batch page overlays: every onPage is a store write that wakes all
    // subscribers, and small server pages (docs is capped at 12 rows for query
    // memory) turn a few-thousand-row crawl into hundreds of writes — measured
    // as a multi-minute ~2 writes/s re-render drip on every cold launch. Buffer
    // rows and flush on size/time so the list still streams in visibly, at a
    // fraction of the commits. Progress rides the same flush cadence.
    const FLUSH_ROWS = 200;
    const FLUSH_MS = 700;
    let buffer: any[] = [];
    let lastFlush = Date.now();
    // `ckpt` is the continuation cursor AFTER the rows being flushed — the rows
    // themselves have landed via onPage, so resuming from it is exact. Undefined
    // skips checkpointing (nothing new to record).
    const flush = (loading: boolean, ckpt?: string | null) => {
      if (buffer.length) {
        opts.onPage(buffer);
        buffer = [];
      }
      lastFlush = Date.now();
      setProgress(namespace, loading, all.length);
      if (ckpt !== undefined && ckpt !== null && !superseded()) {
        useInboxStore.getState().recordSyncMeta(metaKey, { resumeCursor: ckpt, resumeAt: Date.now() });
      }
    };
    for (let i = 0; i < maxPages; i++) {
      // Retry transient page failures with backoff — one hiccup must not abandon
      // the whole crawl and leave a partial list. Give up only after several tries.
      let page: CrawlPage | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!isCurrent()) { stop(all.length); return; }
        try { page = await opts.fetchPage(cursor); break; }
        catch {
          if (attempt === 4) {
            // Persistent failure: don't snapshot a partial set (it would prune
            // real rows). Leave overlaid pages in place; retry next effect run.
            // A resumed run that failed on its FIRST fetch likely holds an
            // expired continuation cursor — clear the checkpoint (after flush,
            // which re-records it) so the next run restarts from page zero
            // instead of failing forever.
            if (!superseded()) { flush(false, cursor); st.runningKey = null; }
            if (resumedMidway && all.length === 0) {
              useInboxStore.getState().recordSyncMeta(metaKey, { resumeCursor: null });
            }
            return;
          }
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
      if (!isCurrent() || !page) { flush(true, cursor); stop(all.length); return; } // a newer workspace crawl took over
      const rows = page.rows ?? [];
      all.push(...rows);
      buffer.push(...rows);
      // Convex paginate may return short/empty pages mid-stream (rows can be 0
      // while more remain) — only isDone marks the true end. seenCursors is a
      // belt-and-braces guard against a cursor that never advances.
      const next = page.continueCursor || null;
      const more = !page.isDone && !!next && !seenCursors.has(next);
      if (!more || buffer.length >= FLUSH_ROWS || Date.now() - lastFlush >= FLUSH_MS) flush(more, next);
      if (!more) { completed = true; break; }
      seenCursors.add(next!);
      cursor = next;
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }
    if (buffer.length) flush(true, cursor); // maxPages-truncated: land the tail overlay
    if (!isCurrent()) { stop(all.length); return; }
    // Final completeness pass: re-overlay the full set. onComplete is a DELTA
    // overlay (the big collections are isDelta in SYNC_REGISTRY) — additive, never
    // prunes — so this only fills in rows onPage may have missed. Deletions arrive
    // as deltas, never by snapshot, so a short/truncated crawl can't gut the cache.
    // `completed` lets a pruning consumer (the dismiss CLEAR) know the set is whole.
    // A resumed run only walked the tail — its `all` is partial, so consumers
    // must treat it as incomplete even though the table is cumulatively covered.
    await opts.onComplete(all, completed && !resumedMidway, isCurrent);
    if (!isCurrent()) { stop(all.length); return; }
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
    // resumeCursor: null clears the mid-crawl checkpoint — the walk finished
    // (cumulatively, when resumed), so the next crawl starts fresh after the
    // throttle window and regains full deletion-reconcile authority.
    useInboxStore.getState().recordSyncMeta(metaKey, { backfilledAt: now, cursor: maxUpdated || undefined, resumeCursor: null });
    setProgress(namespace, false, all.length);
    st.doneAt.set(wsKey, now);
    st.runningKey = null;
  })();
}
