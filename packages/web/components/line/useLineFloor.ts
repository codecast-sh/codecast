"use client";
// The rows every line surface reads: the line app and /line/settings mount
// the same feeders and count the same roll-up. Which project is in view is the
// caller's (useLineProjectId reads the address).
import { useMemo } from "react";
import type { SessionDecisionItem, TaskItem } from "../../store/inboxStore";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { workspaceRefOf } from "../../lib/workspaceScope";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useSyncRuns, useWorkspaceRuns } from "../../hooks/useSyncRuns";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useSyncProjectTasks } from "../../hooks/useSyncTasks";
import { useSyncWorkspaceProjects } from "../../hooks/useSyncProjects";
import { isLineCard, lineRollup, type LineCauseTask, type LineFlowRun, type LineProject } from "../../lib/lineFlow";
import { useLineAdmissions } from "./map/useLineAdmission";

const RUNS_FEED = { limit: 200 };

const causeSig = (t: TaskItem & LineCauseTask) =>
  t.cause ? `${t.status}|${t.updated_at ?? 0}|${t.watch_until ?? 0}|${t.goal_ref ?? ""}|${t.cause.signal_count}|${t.cause.dissolved?.at ?? 0}|${t.cause.dissolved?.fixed_at ?? 0}|${t.priority ?? ""}|${t.closed_at ?? 0}|${t.resolved_at ?? 0}|${t.project_id ?? ""}|${t.readiness ?? ""}|${t.assignee ?? ""}` : `|${t.project_id ?? ""}`;
// published_at moves when the profile moves to another checkout or machine,
// which changes where an edit goes even when the content holds still.
export const projectSig = (p: LineProject) => `${p.short_id ?? ""}|${p.title ?? ""}|${p.priority ?? ""}|${p.project_path ?? ""}|${p.line_profile?.changed_at ?? 0}|${p.line_profile?.published_at ?? 0}`;
const cardSig = (d: SessionDecisionItem) => `${d.status}|${d.updated_at ?? 0}|${d.task_id ?? ""}|${d.workflow_run_id ?? ""}`;

/** A project's (or a cause's) own workspace key when it is not the active
 *  one: the floor then reads the line where it lives. */
export function useProjectWorkspace(row: { workspace?: string | null; team_id?: string | null } | null): string | null {
  const active = useActiveWorkspaceKey();
  const ref = row ? workspaceRefOf(row as Parameters<typeof workspaceRefOf>[0]) : null;
  const key = ref ? `${ref.kind}:${ref.id}` : null;
  return key && key !== active ? key : null;
}

export type HeldTask = { _id: string; short_id?: string; workspace?: string | null; team_id?: string | null; project_id?: string | null };

/** The task a ref (a row id or a ct-N) names wherever the store holds it: a problem in another team's workspace is not in the active floor. */
export function heldTask(tasks: Record<string, HeldTask> | undefined, ref: string | null | undefined): HeldTask | null {
  if (!tasks || !ref) return null;
  if (tasks[ref]) return tasks[ref];
  if (!/^ct-/i.test(ref)) return null;
  for (const id in tasks) if (tasks[id]?.short_id === ref) return tasks[id];
  return null;
}

/** `project` pins the floor to one project's line (the project's Line tab).
 *  `workspace` reads the floor where the project lives (its stored access
 *  key) when that is not the active workspace, so a project opened from
 *  another team shows its line without moving the viewer's active team. */
export function useLineFloor(project?: string | null, workspace?: string | null) {
  const signalsFeed = useSyncSignals(workspace);
  const runsFeed = useSyncRuns(RUNS_FEED, true, workspace);
  // Both feeds have answered this load: until then a count read off the rows is the cache's, and may still move.
  const ready = signalsFeed.ready && runsFeed.ready;
  // The active workspace's tasks ride the workspace feeder; another
  // workspace's causes come by project, or the workspace's own window when the
  // line reads a whole other workspace (its address's `ws`).
  useSyncProjectTasks(project, workspace, !!workspace);
  useSyncWorkspaceProjects(workspace);
  const now = useCoarseNow(30_000);

  const signals = useWorkspaceSignals(workspace);
  const tasks = useWorkspaceCollection<TaskItem & LineCauseTask>("tasks", causeSig, workspace);
  const runs = useWorkspaceRuns(workspace) as LineFlowRun[];
  const cards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: isLineCard as (d: SessionDecisionItem) => boolean, sig: cardSig });
  const projects = useWorkspaceCollection<LineProject>("projects", projectSig, workspace);

  const lineRows = useMemo(() => ({ signals, tasks, runs, decisions: cards as Array<SessionDecisionItem & { created_at?: number }> }), [signals, tasks, runs, cards]);
  const admissions = useLineAdmissions(projects);
  const rollup = useMemo(() => lineRollup(lineRows, projects, now, undefined, admissions), [lineRows, projects, now, admissions]);
  return { now, tasks, projects, lineRows, rollup, admissions, ready };
}
