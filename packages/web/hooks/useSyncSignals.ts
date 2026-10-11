// Signals (docs/architecture/the-line-end-to-end.md LE3, LE13): one
// workspace's last two weeks into the `signals` collection, the active one
// unless a surface names the workspace its record lives in (a project's Line
// tab, a cause's task page opened from another team), and every finding of a
// problem opened in the line, whatever its age (useSyncTaskSignals). Both feed
// one home as deltas: the workspace feed prunes its workspace's rows except an
// open problem's, which that problem's feed prunes.
import { useMemo } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { isConvexId } from "../store/inboxStore";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import type { LineSignal } from "../lib/lineFlow";

const api = _api as any;

/** One problem's feed cap (signals.forTask TASK_SIGNAL_CAP). */
const TASK_CAP = 300;

type Row = { workspace?: string; task_id?: string; created_at: number };

/** Problems whose own findings feed is mounted, each with how many mounts: their rows are that feed's to prune. */
const fedTasks = new Map<string, number>();

/** The oldest created_at an answer is complete back to: its window, or its oldest row when it hit the cap. */
export function completeSince(rows: ReadonlyArray<Row>, cap: number, floor: number): number {
  if (rows.length < cap) return floor;
  let oldest = Infinity;
  for (const r of rows) if (r.created_at < oldest) oldest = r.created_at;
  return Math.max(floor, oldest);
}

/** Feeder: a workspace's recent signals; the active one unless `workspace`
 *  names another (a stored access key). */
export function useSyncSignals(workspace?: string | null) {
  const { args, key } = useFeederWorkspace(workspace);
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  const queryArgs = useMemo(() => (teamId === "skip" ? "skip" : teamId ? { team_id: teamId } : {}), [teamId]);
  const syncOpts = useMemo(() => (rows: Row[] | null) => {
    if (!rows || !key) return { isDelta: true };
    return { isDelta: true, pruneAbsentScope: (r: Row) => r.workspace === key && !(r.task_id && fedTasks.has(r.task_id)) };
  }, [key]);
  return useSyncCollection("signals", api.signals.webList, queryArgs as any, { syncOpts });
}

/** Feeder: every finding filed on one problem, while it (or a run on it) is open in the line. */
export function useSyncTaskSignals(taskId: string | null | undefined) {
  const args = useMemo(() => (taskId && isConvexId(taskId) ? { task_id: taskId } : "skip"), [taskId]);
  useWatchEffect(() => {
    if (!taskId) return;
    fedTasks.set(taskId, (fedTasks.get(taskId) ?? 0) + 1);
    return () => { const n = (fedTasks.get(taskId) ?? 1) - 1; if (n > 0) fedTasks.set(taskId, n); else fedTasks.delete(taskId); };
  }, [taskId]);
  const syncOpts = useMemo(() => (rows: Row[] | null) => {
    if (!rows || !taskId) return { isDelta: true };
    const since = completeSince(rows, TASK_CAP, 0);
    return { isDelta: true, pruneAbsentScope: (r: Row) => r.task_id === taskId && r.created_at >= since };
  }, [taskId]);
  return useSyncCollection("signals", api.signals.forTask, args as any, { syncOpts });
}

// The fields readers branch on: a finding's judge and where its review stands
// (learning-loop.md LL11) change after it lands, and the problem page shows both.
const signalSig = (s: LineSignal) => `${s.created_at}|${s.task_id}|${s.reopened ? 1 : 0}|${s.judge ?? ""}|${s.judge_review?.state ?? ""}|${s.judge_review?.waiting_on ?? ""}`;

/** Reader: a workspace's signals out of the store; the active one unless
 *  `workspace` names another. */
export function useWorkspaceSignals(workspace?: string | null): LineSignal[] {
  return useWorkspaceCollection<LineSignal & { workspace: string }>("signals", signalSig, workspace);
}
