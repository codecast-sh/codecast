import { useInboxStore } from "../store/inboxStore";

// Shared full-reconcile crawl, used by useSyncTasks and useSyncDocs.
//
// Both hooks need the same thing: page through EVERY row in the workspace once
// (one-shot `convex.query()` calls — NOT live subscriptions, so the crawl never
// recreates the per-page subscription storm that saturated the backend),
// overlaying each page as a delta so the list visibly streams in, then
// snapshot-syncing the full set to prune stale / cross-workspace / deleted rows.
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
  /** The full set is in hand — snapshot it (authoritative — prunes deletions). */
  onComplete: (all: any[]) => void;
};

/**
 * Kick off a reconcile crawl if one isn't already running / recently done for
 * this workspace. Fire-and-forget: returns immediately, runs in the background,
 * and publishes progress to `syncProgress[namespace]`.
 */
export function runReconcileCrawl(opts: CrawlOptions): void {
  const { namespace, wsKey, throttleMs, pageDelayMs, maxPages } = opts;
  if (wsKey === "skip") return;
  const st = stateFor(namespace);
  // Recently completed for this workspace → serve from the IDB-cached store.
  if (Date.now() - (st.doneAt.get(wsKey) ?? 0) < throttleMs) return;
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
    // Authoritative snapshot: the FULL set is now in hand — prune anything not in
    // it (old workspace after a team switch, deleted rows, etc.).
    opts.onComplete(all);
    setProgress(namespace, false, all.length);
    st.doneAt.set(wsKey, Date.now());
    st.runningKey = null;
  })();
}
