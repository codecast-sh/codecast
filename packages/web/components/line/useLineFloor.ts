"use client";
// The rows every line surface reads, and the line the viewer has chosen: the
// /line flow and /line/settings mount the same feeders, count the same
// roll-up and share the switcher's choice (LineProjects useLineProject), so
// switching pages keeps the project.
import { useMemo } from "react";
import type { SessionDecisionItem, TaskItem } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useSyncRuns, useWorkspaceRuns } from "../../hooks/useSyncRuns";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { isLineCard, lineRollup, type LineCauseTask, type LineFlowRun, type LineProject } from "../../lib/lineFlow";
import { useLineProject } from "./LineProjects";

const RUNS_FEED = { limit: 200 };

const causeSig = (t: TaskItem & LineCauseTask) =>
  t.cause ? `${t.status}|${t.updated_at ?? 0}|${t.watch_until ?? 0}|${t.goal_ref ?? ""}|${t.cause.signal_count}|${t.priority ?? ""}|${t.closed_at ?? 0}|${t.resolved_at ?? 0}|${t.project_id ?? ""}` : `|${t.project_id ?? ""}`;
// published_at moves when the profile moves to another checkout or machine,
// which changes where an edit goes even when the content holds still.
const projectSig = (p: LineProject) => `${p.short_id ?? ""}|${p.title ?? ""}|${p.priority ?? ""}|${p.project_path ?? ""}|${p.line_profile?.changed_at ?? 0}|${p.line_profile?.published_at ?? 0}`;
const cardSig = (d: SessionDecisionItem) => `${d.status}|${d.updated_at ?? 0}|${d.task_id ?? ""}|${d.workflow_run_id ?? ""}`;

/** `project` pins the floor to one project's line (the project's Line tab). */
export function useLineFloor(project?: string | null) {
  useSyncSignals();
  useSyncRuns(RUNS_FEED);
  const now = useCoarseNow(30_000);

  const signals = useWorkspaceSignals();
  const tasks = useWorkspaceCollection<TaskItem & LineCauseTask>("tasks", causeSig);
  const runs = useWorkspaceRuns() as LineFlowRun[];
  const cards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: isLineCard as (d: SessionDecisionItem) => boolean, sig: cardSig });
  const projects = useWorkspaceCollection<LineProject>("projects", projectSig);

  // One project's line (LP1): the roll-up counts every line, the switcher
  // picks one.
  const lineRows = useMemo(() => ({ signals, tasks, runs, decisions: cards as Array<SessionDecisionItem & { created_at?: number }> }), [signals, tasks, runs, cards]);
  const rollup = useMemo(() => lineRollup(lineRows, projects, now), [lineRows, projects, now]);
  const line = useLineProject(rollup, projects, project);
  return { now, tasks, projects, lineRows, rollup, line };
}
