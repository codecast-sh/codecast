"use client";
// One visit of a run to this step, opened on the step page: the run page's own
// step (RunStep), so a row shows the real thing the run page shows (what an
// agent concluded and did in its session, what a script ran and printed, its
// checks, why it failed) and the two pages never tell one visit two ways.
import { useCallback, useMemo, type ReactNode } from "react";
import type { LineModel, StepDecision } from "../../../../lib/line/lineModel";
import { stepMark } from "../../../../lib/line/runPage";
import { runTrace, runVars, varValue, type TraceRun } from "../../../../lib/line/runTrace";
import { settledRun } from "../../../../lib/line/runReport";
import { reviewsOf, type ReviewSource } from "../../../../lib/line/scriptReport";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";
import { useInboxStore } from "../../../../store/inboxStore";
import { useSyncWorkflowRun } from "../../../../hooks/useSyncWorkflows";
import { useLineNav } from "../../widgets/parts";
import { RunStep } from "../views/run/RunStep";
import "../views/run/run.css";

export function StepVisit({ model, ws, d, act, mark, fallback = null }: { model: LineModel; ws: Pick<LineWorkspace, "rows" | "names">; d: StepDecision; act?: ReactNode;
  /** How the row reads the visit, where the page knows better than the visit's own status (handed off for review: waiting). */
  mark?: ReturnType<typeof stepMark>;
  /** Shown when the run is not loaded here. */ fallback?: ReactNode }) {
  const nav = useLineNav();
  // An open visit reads its run whole and current (its node sessions, a handoff's note): the line's run feeds are windowed,
  // so an older run's row can be a copy from before its sessions were last enriched.
  useSyncWorkflowRun(d.runId);
  const run = useMemo(() => model.runs.find((r) => r.id === d.runId) ?? null, [model.runs, d.runId]);
  const stored = useInboxStore((s) => (s as unknown as { workflowRuns?: Record<string, TraceRun> }).workflowRuns?.[d.runId] ?? null);
  const raw = (stored ? settledRun(stored) : null) ?? (ws.rows.runs.find((r) => r._id === d.runId) as TraceRun | undefined) ?? null;
  const task = useMemo(() => (d.caseId ? (ws.rows.tasks as unknown as Array<ReviewSource & { _id: string }>).find((t) => t._id === d.caseId) ?? null : null), [ws.rows.tasks, d.caseId]);
  const reviews = useMemo(() => reviewsOf(task), [task]);
  const trace = useMemo(() => (run ? runTrace(model, run, raw, { reviews }) : []), [model, run, raw, reviews]);
  const vars = useMemo(() => (run ? runVars(run, raw) : null), [run, raw]);
  const resolve = useCallback((name: string) => (vars ? varValue(name, vars) : null), [vars]);
  const stepId = d.id.slice(d.runId.length + 1);
  // The run's newest visit of this step that it kept: the one this row is.
  const i = run ? run.visits.reduce((at, v, j) => (v.node === stepId && !v.inferred ? j : at), -1) : -1;
  if (!run || i < 0 || !trace[i]) return <>{fallback}</>;
  const v = run.visits[i];
  const toRun = () => nav.openRun(run.id, run.caseId);
  return (
    <div className="sp-visit" data-line-step-visit={d.id}>
      <RunStep
        model={model}
        run={run}
        visit={v}
        trace={trace[i]}
        mark={mark ?? stepMark(v, trace[i])}
        onJump={toRun}
        resolve={resolve}
        names={ws.names}
        act={act}
        onProblem={nav.openCase}
        onRun={(runId, caseId) => nav.openRun(runId, caseId)}
      />
    </div>
  );
}
