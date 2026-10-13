"use client";
// The Problems list as the page and an open problem's prev and next both read
// it (line-journeys.md LJ8.2): every problem's row with its one status, the
// filter, sort and window the URL holds, and the groups the table draws. The
// facts each status needs are read once here from the workspace: what waits
// on the viewer (lineNeeds), which runs failed or went silent (the Inbox's
// rows), each task's readiness, and whether its project's line is on.
import { useMemo, useRef } from "react";
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import type { LineCauseTask } from "../../../../../lib/lineFlow";
import type { LineModel } from "../../../../../lib/line/lineModel";
import { waitsForFindings } from "../../../../../lib/line/lineInbox";
import { stoppedNeedingYes } from "../../../../../lib/line/lineNeeds";
import { stepLabel } from "../../../../../lib/line/runReport";
import { buildOverview, DEFAULT_RANGE, isOverviewRange, overviewWindow, problemFigures } from "../../../../../lib/line/problemsOverview";
import { isStatusKey, type ProblemFacts, type ProblemNeed } from "../../../../../lib/line/problemStatus";
import {
  buildProblemRows, isProblemSort, lessonOnlyIds, problemOrder, problemRowSig, problemSections, searchProblems, shownOrder, statusCounts,
  type ProblemFilter, type ProblemRow, type ProblemSort,
} from "../../../../../lib/line/problemTable";
import type { LineSelection } from "../../../../../lib/line/lineWorkspaceUrl";
import type { LineWorkspace } from "../../../../../hooks/useLineWorkspace";

export type ProblemList = ReturnType<typeof useProblemList>;

export function useProblemList(model: LineModel, workspace: LineWorkspace, selection: LineSelection) {
  const range = isOverviewRange(selection.win) ? selection.win : DEFAULT_RANGE;
  const status = isStatusKey(selection.status) ? selection.status : null;
  const sort: ProblemSort = isProblemSort(selection.sort) ? selection.sort : null;
  const q = selection.q ?? "";
  // Quiet narrows the fixes in production: it means nothing under another chip.
  const quiet = selection.quiet && status === "shipped";
  const filter: ProblemFilter = useMemo(() => ({ status, quiet, q }), [status, quiet, q]);

  // The window moves once a bucket, never with the clock.
  const winNow = overviewWindow(range, workspace.now);
  const win = useMemo(() => winNow, [range, winNow.d1]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectNames = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title])), [workspace.projects]);
  const projectName = useMemo(() => (id: string | null) => (id ? projectNames.get(id) ?? "" : ""), [projectNames]);

  const facts = useMemo(() => {
    const labelOf = (id: string | null | undefined) => (id ? model.steps[id]?.label ?? stepLabel({ id, label: id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) }) : null);
    const need = new Map<string, ProblemNeed>();
    for (const n of workspace.needs) if (n.caseId && !need.has(n.caseId)) need.set(n.caseId, { kind: n.kind, mine: true, step: labelOf(n.fail?.step) });
    const failed = new Map<string, NonNullable<ProblemFacts["failed"]>>();
    const silent = new Map<string, { since: number }>();
    for (const g of workspace.inbox) for (const r of g.rows) {
      if (!r.caseId) continue;
      if (g.kind === "failed" && r.fail && !stoppedNeedingYes(r.fail)) {
        // A cause that does not name its step ("Out of time, 3h") says where, so two steps' timeouts are two headings a person can tell apart.
        const step = labelOf(r.fail.step);
        failed.set(r.caseId, { key: r.fail.key, label: step && !r.fail.label.toLowerCase().includes(step.toLowerCase()) ? `${r.fail.label} at ${step}` : r.fail.label, step });
      }
      else if (g.kind === "stalled") silent.set(r.caseId, { since: r.at ?? workspace.now });
    }
    const stage = new Map<string, LinePhaseKey>();
    for (const r of model.runs) if (r.live && r.caseId && r.at_node && !stage.has(r.caseId)) { const s = model.steps[r.at_node]?.stage; if (s) stage.set(r.caseId, s); }
    const tasks = new Map((workspace.rows.tasks as LineCauseTask[]).map((t) => [t._id, t]));
    const lineOn = (p: string | null | undefined) => {
      if (!p) return false;
      if (workspace.trialProjects.has(p)) return true;
      const a = workspace.admissions.get(p);
      return !!a?.role && !a.role.paused && a.on;
    };
    return {
      projectOf: (id: string) => tasks.get(id)?.project_id ?? null,
      of: (id: string): ProblemFacts => {
        const task = tasks.get(id) ?? null;
        return {
          need: need.get(id) ?? null, failed: failed.get(id) ?? null, silent: silent.get(id) ?? null, stage: stage.get(id) ?? null, task,
          awaitsFindings: task?.readiness === "needs_context" && waitsForFindings(task.readiness_note),
          lineOn: lineOn(task?.project_id), assigneeName: task?.assignee ? workspace.names.get(task.assignee) ?? null : null,
        };
      },
    };
  }, [model.steps, model.runs, workspace.needs, workspace.inbox, workspace.rows.tasks, workspace.admissions, workspace.trialProjects, workspace.names, workspace.now]);

  // A problem only a lesson filed is a note to the line, not something wrong with the product: it is not listed.
  const lessons = useMemo(() => lessonOnlyIds(workspace.sources), [workspace.sources]);
  // A model rebuild makes every issue anew: a row whose signature held keeps its object, so the memoized rows redraw only the problems that moved.
  const kept = useRef(new Map<string, ProblemRow & { sig: string }>());
  const all = useMemo(() => {
    const next = new Map<string, ProblemRow & { sig: string }>();
    const out = buildProblemRows(model.issues.filter((i) => !lessons.has(i.id)), { win, now: workspace.now, facts: facts.of, projectOf: facts.projectOf, projectName, sources: workspace.sources, overlaps: workspace.overlaps }).map((r) => {
      const sig = problemRowSig(r);
      const was = kept.current.get(r.id);
      const row = was?.sig === sig ? was : { ...r, sig };
      next.set(r.id, row);
      return row;
    });
    kept.current = next;
    return out;
  }, [model.issues, lessons, win, facts, projectName, workspace.sources, workspace.overlaps, workspace.now]);

  const counts = useMemo(() => statusCounts(all, q), [all, q]);
  const sections = useMemo(() => problemSections(all, filter, sort, projectName), [all, filter, sort, projectName]);
  const order = useMemo(() => problemOrder(sections), [sections]);
  const shown = useMemo(() => shownOrder(sections), [sections]);
  // The figures and the chart read what the search keeps, whatever chip is on: a chip narrows the table, not the product's state.
  const searched = useMemo(() => searchProblems(all, q), [all, q]);
  const figures = useMemo(() => problemFigures(searched), [searched]);
  const overview = useMemo(() => buildOverview(searched.map((r) => r.issue), win), [searched, win]);

  return { all, filter, sort, range, win, counts, sections, order, shown, figures, overview, projectName };
}
