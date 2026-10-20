// The CI result of the commit a problem's page names as already fixing it
// (convex lineFixChecks.fixCommitChecks). An enrichment read from GitHub on
// demand, not a synced table: the last answer per commit is kept for the tab so
// a revisit paints at once, and it is read again every two minutes while
// checks are still running. Null until the first answer, and when the read fails.
import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { CommitLive, FixBranch, FixCommitChecks } from "@codecast/convex/convex/lineFixChecks";
import { deployIsLive } from "@codecast/shared/contracts/causeHistory";
import { useCollectionRows } from "./useCollectionRows";
import { useInboxStore } from "../store/inboxStore";
import { ciRunOf } from "../lib/line/fixedOnMain";

const api = _api as any;
const last = new Map<string, FixCommitChecks>();
/** One read per commit at a time, however many places on the page ask. */
const inflight = new Map<string, Promise<FixCommitChecks>>();
const AGAIN_MS = 120_000;

/** `failedRun`: the CI run the problem came from (a finding's GitHub Actions link); the checks it failed answer on their own. */
export function useFixCommitChecks(projectId: string | null, sha: string | null, failedRun?: string | null): FixCommitChecks | null {
  const key = projectId && sha ? `${projectId}:${sha}:${failedRun ?? ""}` : null;
  const read = useAction(api.lineFixChecks.fixCommitChecks);
  const [result, setResult] = useState<FixCommitChecks | null>(() => (key ? last.get(key) ?? null : null));
  useWatchEffect(() => {
    if (!key) return;
    setResult(last.get(key) ?? null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const go = () => {
      const p = inflight.get(key) ?? (read({ project_id: projectId, sha, ...(failedRun ? { failed_run: failedRun } : {}) }) as Promise<FixCommitChecks>).finally(() => inflight.delete(key));
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
  }, [key, read, projectId, sha, failedRun]);
  return result;
}

type SignalRow = { task_id?: string; evidence_url?: string | null };

/** The CI run a problem came from: the first of its findings that links a GitHub Actions run. */
export function useProblemCiRun(taskId: string | null | undefined): string | null {
  return useInboxStore((s) => {
    if (!taskId) return null;
    for (const sg of Object.values((s.signals ?? {}) as Record<string, SignalRow>)) if (sg.task_id === taskId && ciRunOf(sg.evidence_url)) return sg.evidence_url!;
    return null;
  });
}

type LiveDeploy = { _id: string; at: number; sha: string | null; environment?: string | null; status?: string };
const liveDeploySig = (d: LiveDeploy) => `${d.at}|${d.sha ?? ""}|${d.environment ?? ""}|${d.status ?? ""}`;
/** A deploy that put code live: one the line asked for that never went out (requested, failed) did not (deploys.md DP1). */
export const wentLive = (d: { status?: string }) => !d.status || d.status === "live";
const liveRead = new Map<string, CommitLive>();

/** Whether a commit a problem names is in production, and since which recorded deploy (convex lineFixChecks.commitLive:
 *  ancestry against the live deploys the store holds). Null until the answer arrives, and when the read fails. */
export function useCommitLive(projectId: string | null, sha: string | null): CommitLive | null {
  const rows = useCollectionRows<LiveDeploy>("lineDeploys", { sig: liveDeploySig });
  const deploys = useMemo(() => rows.filter((d) => d.sha && wentLive(d) && deployIsLive({ environment: d.environment ?? null })).map((d) => ({ sha: d.sha!, at: d.at })), [rows]);
  const newest = deploys.reduce((m, d) => Math.max(m, d.at), 0);
  const key = projectId && sha && deploys.length ? `${projectId}:${sha}:${newest}` : null;
  const read = useAction(api.lineFixChecks.commitLive);
  const [result, setResult] = useState<CommitLive | null>(() => (key ? liveRead.get(key) ?? null : null));
  useWatchEffect(() => {
    if (!key) return;
    setResult(liveRead.get(key) ?? null);
    let live = true;
    (read({ project_id: projectId, sha, deploys }) as Promise<CommitLive>).then((r) => { liveRead.set(key, r); if (live) setResult(r); }).catch(() => {});
    return () => { live = false; };
    // The deploys are read when the newest of them changes (the key), not on every new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read]);
  return result;
}

const branchRead = new Map<string, FixBranch>();
const branchInflight = new Map<string, Promise<FixBranch>>();

/** A fix branch handed off for review, read whole from GitHub (convex lineFixChecks.fixBranch): its diff, how far the
 *  default branch moved since it left, the files moved on both, its head's checks. Kept for the tab so a revisit paints
 *  at once, read again on each mount. Null until the first answer, and when the read fails. */
export function useFixBranch(projectId: string | null, branch: string | null, runId: string | null = null): FixBranch | null {
  // The run names its own branch and repository (lineFixChecks runFixBranch); `branch` is read when it names none.
  const key = projectId && (branch || runId) ? `${projectId}:${runId ?? ""}:${branch ?? ""}` : null;
  // Read through a ref: the effect is about what is read (`key`), never the action function's identity.
  const action = useAction(api.lineFixChecks.fixBranch);
  const read = useRef(action);
  read.current = action;
  const [result, setResult] = useState<FixBranch | null>(() => (key ? branchRead.get(key) ?? null : null));
  useWatchEffect(() => {
    if (!key) return;
    setResult(branchRead.get(key) ?? null);
    let live = true;
    const p = branchInflight.get(key) ?? (read.current({ project_id: projectId, ...(branch ? { branch } : {}), ...(runId ? { run_id: runId } : {}) } as never) as Promise<FixBranch>).finally(() => branchInflight.delete(key));
    branchInflight.set(key, p);
    p.then((r) => { branchRead.set(key, r); if (live) setResult(r); }).catch(() => {});
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- key names projectId, runId and branch
  return result;
}
