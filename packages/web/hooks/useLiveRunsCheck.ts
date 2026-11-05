// The live runs check (the sync host's, HostFeeders): the store's runs arrive
// through windowed delta feeds (listRuns keeps a workspace's newest 50), and a
// run that ended while no tab was open, after it left every window, keeps its
// cached live status for good: every surface reading `workflowRuns` would show
// it running, or waiting on a person. workflow_runs.liveIds names every live
// run in the viewer's workspaces; each run the store holds as live in one of
// them that the answer does not name is asked for again by id
// (workflow_runs.byIds), and its row heals in place. The walk runs when the
// answer changes and when the collection does (cached rows hydrate after the
// first answer), in this leaf, so nothing else re-renders.
import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useSyncCollection } from "./useSyncCollection";

const LIVE_IDS = makeFunctionReference<"query">("workflow_runs:liveIds");
const RUNS_BY_IDS = makeFunctionReference<"query">("workflow_runs:byIds");
/** workflow_runs.byIds answers at most this many (RUNS_BY_IDS_MAX); a longer list heals over several answers. */
const ASK_MAX = 200;
const LIVE = new Set(["pending", "running", "paused"]);

type LiveAnswer = { workspaces: string[]; ids: string[]; complete: boolean };
type RunRow = { _id: string; status?: string; workspace?: string };

/** The runs the store holds as live, in a workspace the answer covers, that the answer does not name. */
export function staleLiveRuns(runs: Record<string, RunRow>, answer: LiveAnswer, max = ASK_MAX): string[] {
  if (!answer.complete) return [];
  const covered = new Set(answer.workspaces);
  const live = new Set(answer.ids);
  const out: string[] = [];
  for (const r of Object.values(runs)) {
    if (out.length >= max) break;
    if (r.workspace && covered.has(r.workspace) && LIVE.has(r.status ?? "") && !live.has(r._id) && isConvexId(r._id)) out.push(r._id);
  }
  return out.sort();
}

export function LiveRunsCheck(): null {
  const { data: answer } = useQueryNoThrow(LIVE_IDS, {});
  const runs = useInboxStore((s) => (s as unknown as { workflowRuns?: Record<string, RunRow> }).workflowRuns);
  const stale = useMemo(() => (answer && runs ? staleLiveRuns(runs, answer as LiveAnswer) : []), [answer, runs]);
  const key = stale.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the ids, so a walk that finds the same rows keeps the subscription
  const args = useMemo(() => (stale.length ? { ids: stale } : "skip"), [key]);
  useSyncCollection("workflowRuns", RUNS_BY_IDS, args as { ids: string[] } | "skip");
  return null;
}
