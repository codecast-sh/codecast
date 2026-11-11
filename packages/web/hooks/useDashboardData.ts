// A dashboard's data on the page: the feeders that keep its query answers
// (dataResults) and its source list (dataSources) in the store, the heartbeat
// that keeps those answers fresh, and the readers blocks paint from.
//
// Freshness is driven by whoever has the dashboard open: on mount, whenever
// the set of bound queries changes, and every minute while the tab is
// visible, `want` tells the server which queries the blocks bind to, and it
// starts one refresh for each answer past its interval. The answer arrives
// through the results feed like any other change.
import { useCallback, useMemo, useRef } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

export type DataResult = dashboard.DataResult & { _id: string; doc_id: string };
export type SourceRow = { _id: string; doc_id: string; group: string; source: string; label: string; detail: string; args?: Record<string, unknown>; columns?: string };

const HEARTBEAT_MS = 60_000;

const resultSig = (r: DataResult) => `${r.qkey}|${r.refreshed_at}|${r.error ?? ""}|${r.refreshing ? 1 : 0}|${r.truncated ? 1 : 0}`;

/** Mount the results feed for a doc (once per page) and keep its queries fresh. */
export function useDashboardFeed(docId: string, blocks: readonly ArtifactElement[], opts: { shareToken?: string; canWant: boolean }) {
  useSyncCollection("dataResults", api.dataQueries.results, docId ? { doc_id: docId as any, ...(opts.shareToken ? { share_token: opts.shareToken } : {}) } : "skip", {
    select: useCallback((rows: any) => (Array.isArray(rows) ? rows.map((r: any) => ({ ...r, _id: String(r._id), doc_id: String(r.doc_id) })) : rows), []),
    dropAbsent: useCallback((row: any) => row?.doc_id === docId, [docId]),
  });

  const queries = useMemo(() => dashboard.dashboardQueries(blocks), [blocks]);
  const sig = useMemo(() => [...queries.entries()].map(([k, q]) => `${k}@${q.refresh ?? ""}`).sort().join(","), [queries]);
  const latest = useRef(queries);
  latest.current = queries;
  const want = useMutation(api.dataRefresh.want);
  const wantShared = useMutation(api.dataRefresh.wantShared);

  useWatchEffect(() => {
    if (!docId || !opts.canWant) return;
    let first = true;
    const send = () => {
      // The first ask always goes out, so a page opened in a background tab (or a headless viewer) still gets fresh numbers; later beats wait for a visible tab.
      if (!first && typeof document !== "undefined" && document.hidden) return;
      first = false;
      const list = [...latest.current.values()];
      if (!list.length) return;
      const sent = opts.shareToken ? wantShared({ doc_id: docId as any, share_token: opts.shareToken }) : want({ doc_id: docId as any, queries: list as any });
      sent.catch(() => {
        /* the next beat retries; a refused query shows its reason on the block */
      });
    };
    send();
    const timer = setInterval(send, HEARTBEAT_MS);
    const onVisible = () => !document.hidden && send();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [docId, sig, opts.canWant, opts.shareToken, want, wantShared]);
}

/** The doc's answers keyed by query key. Re-renders only when an answer moves. */
export function useDataResults(docId: string): Map<string, DataResult> {
  const where = useCallback((r: DataResult) => r.doc_id === docId, [docId]);
  const rows = useCollectionRows<DataResult>("dataResults", { where, sig: resultSig });
  return useMemo(() => new Map(rows.map((r) => [r.qkey, r])), [rows]);
}

/** The answer a block reads, if it binds to one. */
export function resultFor(results: Map<string, DataResult>, block: object): DataResult | undefined {
  const q = dashboard.blockQuery(block);
  return q ? results.get(dashboard.queryKey(q)) : undefined;
}

/** The sources panel's list; the feed runs only while `open`. */
export function useDataSources(docId: string, open: boolean): { rows: SourceRow[]; loading: boolean } {
  const { ready } = useSyncCollection("dataSources", api.dataQueries.sources, open && docId ? { doc_id: docId as any } : "skip", {
    dropAbsent: useCallback((row: any) => row?.doc_id === docId, [docId]),
  });
  const where = useCallback((r: SourceRow) => r.doc_id === docId, [docId]);
  const sigFn = useCallback((r: SourceRow) => `${r.label}|${r.detail}`, []);
  const rows = useCollectionRows<SourceRow>("dataSources", { where, sig: sigFn });
  return { rows, loading: open && !ready && rows.length === 0 };
}

/** Run a query once (the sources panel preview, the editor's column list). */
export function usePreviewQuery() {
  return useAction(api.dataQueries.preview);
}

/** Re-run one query now and get its fresh answer back: the check behind a number. */
export function useRerun() {
  return useAction(api.dataQueries.rerun);
}
