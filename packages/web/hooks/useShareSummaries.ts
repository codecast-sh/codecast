import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { startOfDay, type PathShareSummary } from "../lib/team/shareImpact";

// The server counts at most twelve directories per call; smaller batches keep
// one heavy repository from holding up the rest of the page.
const BATCH = 6;

/**
 * Exact counts for every directory on the sharing page, read once when the
 * page opens and again after a write, never as a live subscription. A
 * subscription per row rescans up to two thousand sessions on every write in
 * that repository; a page with thirty rows held thirty one of them. Each
 * summary reads its directory at its own share start (the mapping's) and
 * counts the sessions before today, so a menu can say what "from today"
 * keeps private without a second read. A batch that fails (a read budget,
 * a transient) is retried one directory at a time so one bad path cannot
 * blank the others.
 */
export function useShareSummaries(paths: string[]): {
  summaries: Record<string, PathShareSummary>;
  loading: boolean;
  reload: () => void;
} {
  const convex = useConvex();
  const [summaries, setSummaries] = useState<Record<string, PathShareSummary>>({});
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const key = useMemo(() => [...new Set(paths)].sort().join("\n"), [paths]);

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (list.length === 0) return;
    // The cleanup flag is per effect run, so a strict mode double mount or a
    // path change discards only the run it belongs to.
    let cancelled = false;
    setLoading(true);
    const dayStart = startOfDay();
    const read = (prefixes: string[]) =>
      convex.query(api.users.shareImpactForPaths, { path_prefixes: prefixes, day_start: dayStart }) as Promise<Record<string, PathShareSummary>>;
    (async () => {
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        let part: Record<string, PathShareSummary> = {};
        try {
          part = await read(chunk);
        } catch (err) {
          console.error("share summary batch failed, retrying one at a time:", err);
          for (const prefix of chunk) {
            try {
              Object.assign(part, await read([prefix]));
            } catch (single) {
              console.error(`share summary failed for ${prefix}:`, single);
            }
          }
        }
        if (cancelled) return;
        // Rows fill in as each batch lands rather than all at once at the end.
        setSummaries((prev) => ({ ...prev, ...part }));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [convex, key, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { summaries, loading, reload };
}
