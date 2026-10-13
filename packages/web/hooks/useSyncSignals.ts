// Signals (docs/architecture/the-line-end-to-end.md LE3, LE13): one
// workspace's last two weeks into the `signals` collection, the active one
// unless a surface names the workspace its record lives in (a project's Line
// tab, a cause's task page opened from another team), and every finding of a
// problem opened in the line, whatever its age (useSyncTaskSignals). Both feed
// one home as deltas; the workspace feed drops the rows of its workspace it no
// longer sends, except an open problem's.
import { useMemo } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import type { LineSignal } from "../lib/lineFlow";

const api = _api as any;

type Row = { workspace?: string; task_id?: string };

/** Problems whose own findings feed is mounted, each with how many mounts: their rows are that feed's to drop. */
const fedTasks = new Map<string, number>();

// A drop leaves no tombstone (useSyncCollection dropAbsent), never a prune
// scope's exclude: a row the window lets go, a problem's own feed may send again.

/** Feeder: a workspace's recent signals; the active one unless `workspace`
 *  names another (a stored access key). */
export function useSyncSignals(workspace?: string | null) {
  const { args, key } = useFeederWorkspace(workspace);
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  const queryArgs = useMemo(() => (teamId === "skip" ? "skip" : teamId ? { team_id: teamId } : {}), [teamId]);
  useWatchEffect(() => { useInboxStore.getState().clearTombstones("signals"); }, []);
  const dropAbsent = useMemo(() => (key ? (r: Row) => r.workspace === key && !(r.task_id && fedTasks.has(r.task_id)) : undefined), [key]);
  return useSyncCollection("signals", api.signals.webList, queryArgs as any, { dropAbsent });
}

/** Feeder: every finding filed on one problem (newest 300), while it (or a run on it) is open in the line. */
export function useSyncTaskSignals(taskId: string | null | undefined) {
  const args = useMemo(() => (taskId && isConvexId(taskId) ? { task_id: taskId } : "skip"), [taskId]);
  useWatchEffect(() => {
    if (!taskId) return;
    fedTasks.set(taskId, (fedTasks.get(taskId) ?? 0) + 1);
    return () => { const n = (fedTasks.get(taskId) ?? 1) - 1; if (n > 0) fedTasks.set(taskId, n); else fedTasks.delete(taskId); };
  }, [taskId]);
  return useSyncCollection("signals", api.signals.forTask, args as any);
}

// The fields readers branch on: a finding's judge and where its review stands
// (learning-loop.md LL11) change after it lands, and the problem page shows both.
const signalSig = (s: LineSignal) => `${s.created_at}|${s.task_id}|${s.reopened ? 1 : 0}|${s.judge ?? ""}|${s.judge_review?.state ?? ""}|${s.judge_review?.waiting_on ?? ""}|${s.retired ? 1 : 0}`;

/** Reader: a workspace's signals out of the store; the active one unless
 *  `workspace` names another. A retired copy of another finding is left out. */
export function useWorkspaceSignals(workspace?: string | null): LineSignal[] {
  const rows = useWorkspaceCollection<LineSignal & { workspace: string }>("signals", signalSig, workspace);
  return useMemo(() => (rows.some((s) => s.retired) ? rows.filter((s) => !s.retired) : rows), [rows]);
}
