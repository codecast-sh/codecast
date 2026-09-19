// The scope feed as one paged stream (docs/architecture/scopes-and-feed.md F2):
// the cursor chain, the kind filter and the mounted page loaders, with no
// markup, so the web feed and the phone's feed page the same way. Each page is
// one mounted loader over org.scopeFeed, the way the org page pages
// sessionsUnder: a loader reports its rows and stays mounted so the rows stay live.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useScopeFeedPage, type ScopeRef } from "./useScopeQueries";
import { queryProblem } from "../lib/scopePage";
import type { FeedKind, FeedRow } from "../components/org/scope/scopeTypes";

const PAGE = 40;

/** One page of the feed: fires the query for its cursor, reports once, stays mounted so the row stays live. */
function FeedPageLoader({ scope, cursor, kinds, onPage, onProblem }: { scope: ScopeRef; cursor?: string; kinds: FeedKind[]; onPage: (cursor: string | undefined, rows: FeedRow[], next?: string) => void; onProblem: (message: string) => void }) {
  const { data, error, missing } = useScopeFeedPage({ ...scope, ...(cursor ? { cursor } : {}), limit: PAGE, ...(kinds.length ? { kinds } : {}) });
  useWatchEffect(() => {
    if (data) { onPage(cursor, data.rows ?? [], data.next_cursor ?? undefined); return; }
    const problem = queryProblem(error, missing, "The feed");
    if (problem) onProblem(problem);
  }, [data, error, missing, cursor, onPage, onProblem]);
  return null;
}

export type ScopeFeedStream = {
  /** The kinds in force: the locked set, else what the reader picked. */
  kinds: FeedKind[];
  toggleKind: (k: FeedKind) => void;
  clearKinds: () => void;
  rows: FeedRow[];
  /** The first page has landed. */
  loaded: boolean;
  /** A cursor is waiting on the server. */
  pending: boolean;
  hasMore: boolean;
  problem: string | null;
  loadMore: () => void;
  /** Render this somewhere in the tree: the loaders are what fire the queries. */
  loaders: ReactNode;
};

export function useScopeFeedStream(scope: ScopeRef, lockKinds?: FeedKind[]): ScopeFeedStream {
  const [pickedKinds, setKinds] = useState<FeedKind[]>([]);
  const kinds = lockKinds ?? pickedKinds;
  const scopeKey = JSON.stringify(scope);
  // One stream per scope and kind set. Pages are keyed by the cursor that
  // produced them (the first page's key is ""). The stream carries its own
  // key, so a scope or kind change starts over in the same render: the old
  // cursors are never fired against the new filter, not even for one commit.
  const streamKey = `${scopeKey}|${kinds.join(",")}`;
  type Stream = { key: string; pages: Record<string, { rows: FeedRow[]; next?: string }>; requested: string[]; problem: string | null };
  const fresh = (key: string): Stream => ({ key, pages: {}, requested: [""], problem: null });
  const [streamState, setStream] = useState<Stream>(() => fresh(streamKey));
  const stream = streamState.key === streamKey ? streamState : fresh(streamKey);
  const { pages, requested, problem } = stream;
  // Every setter starts from the current key's stream, never a stale one.
  const patchStream = useCallback((key: string, fn: (s: Stream) => Stream) => {
    setStream((prev) => fn(prev.key === key ? prev : fresh(key)));
  }, []);

  const onPage = useCallback((cursor: string | undefined, rows: FeedRow[], next?: string) => {
    patchStream(streamKey, (prev) => {
      const key = cursor ?? "";
      const cur = prev.pages[key];
      if (cur && cur.next === next && cur.rows.length === rows.length && cur.rows.every((r, i) => r.id === rows[i].id && r.updated_at === rows[i].updated_at)) return prev;
      return { ...prev, pages: { ...prev.pages, [key]: { rows, next } }, problem: null };
    });
  }, [patchStream, streamKey]);
  const onProblem = useCallback((message: string) => {
    patchStream(streamKey, (prev) => (prev.problem === message ? prev : { ...prev, problem: message }));
  }, [patchStream, streamKey]);

  const ordered = useMemo(() => {
    // Walk the chain from the first page so a page that re-fired stays in place.
    const out: FeedRow[] = [];
    const seen = new Set<string>();
    let key = "";
    let last: { rows: FeedRow[]; next?: string } | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = pages[key];
      if (!page) break;
      for (const r of page.rows) if (!seen.has(`${r.kind}:${r.id}`)) { seen.add(`${r.kind}:${r.id}`); out.push(r); }
      last = page;
      if (!page.next) break;
      key = page.next;
    }
    return { rows: out, next: last?.next, loaded: !!pages[""] };
  }, [pages]);

  const pending = requested.some((c) => !pages[c]) && !problem;
  const loadMore = useCallback(() => {
    const next = ordered.next;
    if (!next || pending) return;
    patchStream(streamKey, (prev) => (prev.requested.includes(next) ? prev : { ...prev, requested: [...prev.requested, next] }));
  }, [ordered.next, pending, patchStream, streamKey]);

  const toggleKind = useCallback((k: FeedKind) => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])), []);
  const clearKinds = useCallback(() => setKinds([]), []);

  const loaders = requested.map((c) => <FeedPageLoader key={`${streamKey}|${c}`} scope={scope} cursor={c || undefined} kinds={kinds} onPage={onPage} onProblem={onProblem} />);

  return { kinds, toggleKind, clearKinds, rows: ordered.rows, loaded: ordered.loaded, pending, hasMore: !!ordered.next, problem, loadMore, loaders };
}
