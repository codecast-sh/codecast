import { useCallback, useMemo, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useMutation, useQueries } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { startOfDay, type PathShareSummary } from "../lib/team/shareImpact";

// The server answers at most twelve folders per query.
const BATCH = 12;

/**
 * Exact counts for every folder on the sharing page. Each folder's totals
 * live in one small stats row the server rebuilds by paging through the
 * folder (convex/pathStats.ts), so the subscription here reads a few rows
 * and never the sessions themselves; it updates on its own when a rebuild
 * lands. Opening the page asks for a rebuild of any row older than a minute;
 * `reload` after a write asks again, skipping that window. A folder whose
 * first rebuild has not landed is absent from `summaries`, and the page reads
 * it as still counting.
 */
export function useShareSummaries(paths: string[]): {
  summaries: Record<string, PathShareSummary>;
  loading: boolean;
  reload: () => void;
} {
  const refresh = useMutation(api.pathStats.refreshPathStats);
  const [generation, setGeneration] = useState(0);
  const key = useMemo(() => [...new Set(paths)].sort().join("\n"), [paths]);
  // One day start per page open, so the subscription's args hold still.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dayStart = useMemo(() => startOfDay(), [key]);

  useWatchEffect(() => {
    const list = key ? key.split("\n") : [];
    if (list.length === 0) return;
    void refresh({ paths: list, force: generation > 0 }).catch((err) => console.error("path stats refresh failed:", err));
  }, [key, generation, refresh]);

  const queries = useMemo(() => {
    const list = key ? key.split("\n") : [];
    const out: Record<string, { query: typeof api.users.shareImpactForPaths; args: { path_prefixes: string[]; day_start: number } }> = {};
    for (let i = 0; i < list.length; i += BATCH) {
      out[String(i)] = { query: api.users.shareImpactForPaths, args: { path_prefixes: list.slice(i, i + BATCH), day_start: dayStart } };
    }
    return out;
  }, [key, dayStart]);
  const results = useQueries(queries);

  const summaries = useMemo(() => {
    const out: Record<string, PathShareSummary> = {};
    for (const value of Object.values(results)) {
      if (value && !(value instanceof Error)) Object.assign(out, value as Record<string, PathShareSummary>);
    }
    return out;
  }, [results]);
  const count = key ? key.split("\n").length : 0;
  const loading = Object.keys(summaries).length < count;

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { summaries, loading, reload };
}
