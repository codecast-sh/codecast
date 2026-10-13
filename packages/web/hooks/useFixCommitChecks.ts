// The CI result of the commit a problem's page names as already fixing it
// (convex lineFixChecks.fixCommitChecks). An enrichment read from GitHub on
// demand, not a synced table: the last answer per commit is kept for the tab so
// a revisit paints at once, and it is read again every two minutes while
// checks are still running. Null until the first answer, and when the read fails.
import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { FixCommitChecks } from "@codecast/convex/convex/lineFixChecks";

const api = _api as any;
const last = new Map<string, FixCommitChecks>();
/** One read per commit at a time, however many places on the page ask. */
const inflight = new Map<string, Promise<FixCommitChecks>>();
const AGAIN_MS = 120_000;

export function useFixCommitChecks(projectId: string | null, sha: string | null): FixCommitChecks | null {
  const key = projectId && sha ? `${projectId}:${sha}` : null;
  const read = useAction(api.lineFixChecks.fixCommitChecks);
  const [result, setResult] = useState<FixCommitChecks | null>(() => (key ? last.get(key) ?? null : null));
  useEffect(() => {
    if (!key) return;
    setResult(last.get(key) ?? null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const go = () => {
      const p = inflight.get(key) ?? (read({ project_id: projectId, sha }) as Promise<FixCommitChecks>).finally(() => inflight.delete(key));
      inflight.set(key, p);
      p.then((r: FixCommitChecks) => {
        if (!live) return;
        last.set(key, r);
        setResult(r);
        if (r.state === "pending") timer = setTimeout(go, AGAIN_MS);
      }).catch(() => {});
    };
    go();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [key, read, projectId, sha]);
  return result;
}
