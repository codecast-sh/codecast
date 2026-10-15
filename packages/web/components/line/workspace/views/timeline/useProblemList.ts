"use client";
// The Problems list as the page and an open problem's prev and next both read
// it (line-journeys.md LJ8.2): every problem's row with its one status, the
// filter, sort and window the URL holds, and the groups the table draws. It
// spans every process, as For you does, so "Waiting on you" and "Approved, not
// merged" here together are For you's count; `process` in the address narrows it to one. The
// facts each status needs are read once here from the workspace: what waits
// on the viewer (lineNeeds), which runs failed or went silent (the Inbox's
// rows), each task's readiness, and whether its project's line is on.
import { useMemo, useRef } from "react";
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import type { LineCauseTask } from "../../../../../lib/lineFlow";
import type { LineModel } from "../../../../../lib/line/lineModel";
import type { MapRun } from "../../../../../lib/line/lineMap";
import { waitsForFindings } from "../../../../../lib/line/lineInbox";
import { stoppedNeedingYes } from "../../../../../lib/line/lineNeeds";
import { stepLabel } from "../../../../../lib/line/runReport";
import { bucketAt, buildOverview, DEFAULT_RANGE, finderShifts, isOverviewRange, overviewWindow, problemFigures } from "../../../../../lib/line/problemsOverview";
import { isStatusKey, type ProblemFacts, type ProblemNeed } from "../../../../../lib/line/problemStatus";
import { landingOutput, newestRuns } from "../../../../../lib/line/problemPage";
import { useInboxStore } from "../../../../../store/inboxStore";
import { goalOfRefs, inStartOrder, type RankTask } from "../../../../../lib/line/lineStartOrder";
import {
  buildProblemRows, isProblemSort, lineStepsOf, lessonOnlyIds, problemOrder, problemRowSig, problemSections, searchProblems, shownOrder, statusCounts,
  type FoundFilter, type ProblemFilter, type ProblemRow, type ProblemSort,
} from "../../../../../lib/line/problemTable";
import type { LineSelection } from "../../../../../lib/line/lineWorkspaceUrl";
import type { LineWorkspace } from "../../../../../hooks/useLineWorkspace";

export type ProblemList = ReturnType<typeof useProblemList>;

/** The newest step of a run's trace that failed, past the graph's own start and end steps. */
function lastFailedNode(nodes: MapRun["node_statuses"]): string | null {
  for (let i = (nodes?.length ?? 0) - 1; i >= 0; i--) {
    const n = nodes![i];
    if (n.status === "failed" && n.node_id !== "start" && n.node_id !== "exit" && !n.node_id.startsWith("failed_at")) return n.node_id;
  }
  return null;
}

/** The person's step a run is paused at, when it waits on an answer. */
function gateOf(r: MapRun | undefined, holderOf: (runId: string) => string | null): ProblemFacts["gate"] {
  const run = r as (MapRun & { status?: string; gate_node_id?: string | null; updated_at?: number }) | undefined;
  if (!run || run.status !== "paused" || !run.gate_node_id) return null;
  const at = run.node_statuses?.find((n) => n.node_id === run.gate_node_id)?.started_at;
  return { node: run.gate_node_id, since: at ?? run.updated_at ?? null, holder: holderOf(String(run._id)) };
}

export function useProblemList(model: LineModel, workspace: LineWorkspace, selection: LineSelection) {
  const range = isOverviewRange(selection.win) ? selection.win : DEFAULT_RANGE;
  const status = isStatusKey(selection.status) ? selection.status : null;
  const sort: ProblemSort = isProblemSort(selection.sort) ? selection.sort : null;
  const q = selection.q ?? "";
  // Quiet narrows the fixes in production: it means nothing under another chip.
  const quiet = selection.quiet && status === "shipped";

  // The window moves once a bucket, never with the clock.
  const winNow = overviewWindow(range, workspace.now);
  const win = useMemo(() => winNow, [range, winNow.d1]); // eslint-disable-line react-hooks/exhaustive-deps
  // A figure's or a bar's narrowing: the problems found more than the window before, or those with findings in one bar
  // (a bar of another window, from an older link, narrows nothing).
  const bar = selection.found && selection.found !== "more" ? bucketAt(win, Number(selection.found)) : null;
  const found: FoundFilter = selection.found === "more" ? "more" : bar;
  const foundKey = found === "more" ? "more" : found ? String(found.from) : "";
  const filter: ProblemFilter = useMemo(() => ({ status, quiet, q, found }), [status, quiet, q, foundKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectNames = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title])), [workspace.projects]);
  const projectName = useMemo(() => (id: string | null) => (id ? projectNames.get(id) ?? "" : ""), [projectNames]);

  const facts = useMemo(() => {
    const labelOf = (id: string | null | undefined) => (id ? model.steps[id]?.label ?? stepLabel({ id, label: id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) }) : null);
    const need = new Map<string, ProblemNeed>();
    for (const n of workspace.needs) if (n.caseId && !need.has(n.caseId)) need.set(n.caseId, { kind: n.kind, mine: true, step: labelOf(n.fail?.step), runId: n.runId, ask: n.kind === "stopped" || n.kind === "duplicate" ? n.ask : null, why: n.kind === "reask" ? n.why : null, trial: n.trial && !n.publishes });
    const failed = new Map<string, NonNullable<ProblemFacts["failed"]>>();
    const silent = new Map<string, { since: number }>();
    for (const g of workspace.allInbox) for (const r of g.rows) {
      if (!r.caseId) continue;
      // A stop that needs a yes and a build handed off for review wait on a person (needs), never failures.
      if (g.kind === "failed" && r.fail && !stoppedNeedingYes(r.fail) && !r.fail.key.startsWith("review:")) {
        // A cause that does not name its step ("Out of time, 3h") says where, so two steps' timeouts are two headings a person can tell apart.
        const step = labelOf(r.fail.step);
        const steps = [...new Set([r.fail.step, r.fail.check?.step].filter((x): x is string => !!x))];
        failed.set(r.caseId, { key: r.fail.key, label: step && !r.fail.label.toLowerCase().includes(step.toLowerCase()) ? `${r.fail.label} at ${step}` : r.fail.label, step, steps });
      }
      else if (g.kind === "stalled") silent.set(r.caseId, { since: r.at ?? workspace.now });
    }
    const stage = new Map<string, LinePhaseKey>();
    for (const r of model.runs) if (r.live && r.caseId && r.at_node && !stage.has(r.caseId)) { const s = model.steps[r.at_node]?.stage; if (s) stage.set(r.caseId, s); }
    const tasks = new Map((workspace.rows.tasks as LineCauseTask[]).map((t) => [t._id, t]));
    // The step a problem's newest run failed at, read off its trace, for a failure no Inbox row names (a ship step that
    // refused to merge, evals that could not score): the list holds no visits, and a heading must still name the step.
    const failedStep = new Map<string, { label: string; node: string }>();
    const newest = newestRuns((workspace.rows.runs ?? []) as MapRun[]);
    // Who holds a run's open question: the queue its pending decision sits in.
    const holders = new Map<string, string[]>();
    for (const d of (workspace.decisions ?? []) as ReadonlyArray<{ status?: string; workflow_run_id?: string; asked_user_ids?: string[] }>) {
      if (d.status === "pending" && d.workflow_run_id && d.asked_user_ids?.length) holders.set(d.workflow_run_id, d.asked_user_ids);
    }
    const holderOf = (runId: string) => { const names = (holders.get(runId) ?? []).map((u) => workspace.names.get(u)).filter(Boolean); return names.length ? names.join(", ") : null; };
    for (const [caseId, r] of newest) { const node = lastFailedNode(r.node_statuses); if (node) failedStep.set(caseId, { label: labelOf(node) ?? node, node }); }
    // A problem whose newest run is a trial's: its answered card ships nothing.
    const trial = new Set(workspace.problems.flatMap((i) => { const a = i.history.attempts[i.history.attempts.length - 1]; return a && workspace.trialRuns.has(a.runId) ? [i.id] : []; }));
    // On, off, or null where no role holds the project's line (nothing to turn on: it needs setting up).
    const lineOn = (p: string | null | undefined): boolean | null => {
      if (!p) return null;
      if (workspace.trialProjects.has(p)) return true;
      const a = workspace.admissions.get(p);
      return a?.role ? !a.role.paused && a.on : null;
    };
    return {
      projectOf: (id: string) => tasks.get(id)?.project_id ?? null,
      of: (id: string): ProblemFacts => {
        const task = tasks.get(id) ?? null;
        return {
          need: need.get(id) ?? null, failed: failed.get(id) ?? null, silent: silent.get(id) ?? null, stage: stage.get(id) ?? null, task,
          awaitsFindings: task?.readiness === "needs_context" && waitsForFindings(task.readiness_note),
          failedStep: failedStep.get(id)?.label ?? null, failedNode: failedStep.get(id)?.node ?? null, lineOn: lineOn(task?.project_id), lead: task?.project_id ? workspace.admissions.get(task.project_id)?.role?.handle ?? null : null, idle: task?.project_id ? workspace.trialHeld?.get(task.project_id) ?? null : null, assigneeName: task?.assignee ? workspace.names.get(task.assignee) ?? null : null,
          notes: (task as { comments?: ProblemFacts["notes"] } | null)?.comments, trial: trial.has(id),
          aboutSteps: lineStepsOf(task?.cause?.fingerprints),
          handoff: (task as { verification_evidence?: string | null } | null)?.verification_evidence ?? null,
          shipOutput: landingOutput(newest.get(id)?.node_statuses as Parameters<typeof landingOutput>[0]),
          gate: gateOf(newest.get(id), holderOf),
        };
      },
    };
  }, [model.steps, model.runs, workspace.needs, workspace.allInbox, workspace.rows.tasks, workspace.rows.runs, workspace.decisions, workspace.admissions, workspace.trialProjects, workspace.trialHeld, workspace.trialRuns, workspace.problems, workspace.names, workspace.now]);

  // A problem only a lesson filed is a note to the line, not something wrong with the product: it is not listed.
  const lessons = useMemo(() => lessonOnlyIds(workspace.sources), [workspace.sources]);
  // A model rebuild makes every issue anew: a row whose signature held keeps its object, so the memoized rows redraw only the problems that moved.
  const kept = useRef(new Map<string, ProblemRow & { sig: string }>());
  const process = selection.process && workspace.problems.some((i) => i.process === selection.process) ? selection.process : null;
  const all = useMemo(() => {
    const next = new Map<string, ProblemRow & { sig: string }>();
    const out = buildProblemRows(workspace.problems.filter((i) => !lessons.has(i.id) && (!process || i.process === process)), { win, now: workspace.now, facts: facts.of, projectOf: facts.projectOf, projectName, sources: workspace.sources, overlaps: workspace.overlaps }).map((r) => {
      const sig = problemRowSig(r);
      const was = kept.current.get(r.id);
      const row = was?.sig === sig ? was : { ...r, sig };
      next.set(r.id, row);
      return row;
    });
    kept.current = next;
    return out;
  }, [workspace.problems, process, lessons, win, facts, projectName, workspace.sources, workspace.overlaps, workspace.now]);

  const counts = useMemo(() => statusCounts(all, q, filter.found), [all, q, filter.found]);
  // The line's start order (lineStartOrder): Not started lists a project's ready problems in it.
  const startOrder = useMemo(() => {
    const goalOf = goalOfRefs(workspace.projects as Array<{ short_id?: string; priority?: string | null }>);
    return new Map(inStartOrder(workspace.rows.tasks as unknown as RankTask[], goalOf).map((t, i) => [t._id, i]));
  }, [workspace.projects, workspace.rows.tasks]);
  const sections = useMemo(() => problemSections(all, filter, sort, projectName, startOrder), [all, filter, sort, projectName, startOrder]);
  const order = useMemo(() => problemOrder(sections), [sections]);
  const shown = useMemo(() => shownOrder(sections), [sections]);
  // The figures and the chart read what the search keeps, whatever chip, figure or bar narrows the table: they are the
  // product's state, and the control that narrowed shows pressed. Both count whole series only (problemFigures).
  const searched = useMemo(() => searchProblems(all, q), [all, q]);
  // A folded twin's findings are findings all the same: the figures and the chart count them with its older problem's.
  const counted = useMemo(() => searched.flatMap((r) => [r, ...(r.twins ?? [])]), [searched]);
  const figures = useMemo(() => problemFigures(searched, win), [searched, win]);
  const overview = useMemo(() => buildOverview(counted.filter((r) => r.series).map((r) => r.issue), win), [counted, win]);
  // The finders whose own volume moved the chart (one stopped, one ran far less): named on the bars they affect.
  const shifts = useMemo(() => {
    const ids = new Set(counted.filter((r) => r.series).map((r) => r.id));
    const signals = (workspace.rows.signals as Array<{ source: string; judge?: string | null; created_at: number; observed_at?: number | null; task_id?: string | null }>).filter((s) => !!s.task_id && ids.has(s.task_id));
    return finderShifts(signals, win, workspace.heldFrom);
  }, [counted, workspace.rows.signals, workspace.heldFrom, win]);

  return { all, searched, process, filter, sort, range, win, counts, sections, order, shown, figures, overview, shifts, projectName };
}
