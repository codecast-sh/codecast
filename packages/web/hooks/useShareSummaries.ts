import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { startOfDay, type PathShareSummary } from "../lib/team/shareImpact";

// The server counts at most this many directories per call.
const BATCH = 12;

/**
 * Exact counts for every directory on the sharing page, read once when the
 * page opens and again after a write, never as a live subscription. A
 * subscription per row rescans up to two thousand sessions on every write in
 * that repository; a page with thirty rows held thirty one of them. Each
 * summary reads its directory at its own share start (the mapping's) and
 * counts the sessions before today, so a menu can say what "from today"
 * keeps private without a second read.
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
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (list.length === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const dayStart = startOfDay();
      const next: Record<string, PathShareSummary> = {};
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        try {
          const part = (await convex.query(api.users.shareImpactForPaths, { path_prefixes: chunk, day_start: dayStart })) as Record<string, PathShareSummary>;
          Object.assign(next, part);
        } catch (err) {
          console.error("share summary read failed:", err);
        }
        if (cancelled || !alive.current) return;
        // Rows fill in as each batch lands rather than all at once at the end.
        setSummaries((prev) => ({ ...prev, ...next }));
      }
      if (!cancelled && alive.current) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [convex, key, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { summaries, loading, reload };
}
