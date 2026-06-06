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
  /** Final additive overlay of the full set (delta — never prunes). */
  onComplete: (all: any[]) => void;
};

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
  // whole table on every launch. The module-scope doneAt covers the in-session case.
  const persistedDoneAt = useInboxStore.getState().syncMeta[metaKey]?.backfilledAt ?? 0;
  const lastDoneAt = Math.max(st.doneAt.get(wsKey) ?? 0, persistedDoneAt);
  if (Date.now() - lastDoneAt < throttleMs) return;
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
      if (!more) break;
      seenCursors.add(next!);
      cursor = next;
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }
    if (superseded()) return;
    // Final completeness pass: re-overlay the full set. onComplete is a DELTA
    // overlay (the big collections are isDelta in SYNC_REGISTRY) — additive, never
    // prunes — so this only fills in rows onPage may have missed. Deletions arrive
    // as deltas, never by snapshot, so a short/truncated crawl can't gut the cache.
    opts.onComplete(all);
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
