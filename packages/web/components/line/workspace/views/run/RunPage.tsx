"use client";
// A run's page (line-journeys.md LJ8.4), under its problem: Problems > ct-N >
// Run 3. Its job is to read what this run did. The head holds the six-stage
// track and the one line of state, with the true stop (lib/line/runPage);
// left, the steps the run took; right, the selected step as the real thing
// (RunStep). The page opens on the step that carries how the run ended: the
// person step of a run that waits, the first failed step of a run that
// failed, the Park step, the Build step of a fix that merged. That step holds
// the page's one act: the thing that waits, answered there (WaitingItem), or
// Start again through its review. `step` in the URL names another step; Up
// and Down walk the trace while focus is in it; the shell's Esc goes back to the problem.
import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import type { LineRunModel } from "../../../../../lib/line/lineModel";
import { needOfCase } from "../../../../../lib/line/lineNeeds";
import { visitOf } from "../../../../../lib/line/replay";
import { endedAtDecision, problemTitle } from "../../../../../lib/line/problemPage";
import { clauseHeading, isCause } from "../../../../../lib/lineFlow";
import { runHref } from "../../../../../lib/decisionLinks";
import { runNumber, runStop, stepMark } from "../../../../../lib/line/runPage";
import { runTrace, runVars, varValue, type TraceRun } from "../../../../../lib/line/runTrace";
import { reviewsOf, type ReviewSource } from "../../../../../lib/line/scriptReport";
import { settledRun, type ReportRun } from "../../../../../lib/line/runReport";
import { stageTrack } from "../../../../../lib/line/stageTrack";
import { useTrialCards } from "../../../../../hooks/useSyncTrial";
import { useStationInput } from "../../../../../hooks/useLineWorkspace";
import { useSyncTaskSignals } from "../../../../../hooks/useSyncSignals";
import { useInboxStore } from "../../../../../store/inboxStore";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { StageTrack } from "../../../widgets/StageTrack";
import type { LineViewProps } from "../types";
import { RunStep, type RunLanding } from "./RunStep";
import { RunTrace, type TraceRow } from "./RunTrace";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { ClosedDecisionDock } from "../../../widgets/ClosedDecisionActs";
import "./run.css";

/** Reads every agent step's brief as the run opens, so "What it was told" paints at once when it is opened. */
const BriefPrefetch = memo(function BriefPrefetch({ sessions, runId }: { sessions: ReadonlyArray<string>; runId: string }) {
  return <>{sessions.map((id) => <Prefetch key={id} sessionId={id} runId={runId} />)}</>;
});
function Prefetch({ sessionId, runId }: { sessionId: string; runId: string }) {
  useStationInput(sessionId, runId);
  return null;
}

type TaskRow = ReviewSource & { _id: string; short_id?: string; status?: string; project_id?: string | null; readiness?: string | null; readiness_note?: string | null; cause?: { signal_count: number } | null };
type DecisionRow = { _id: string; short_id?: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number };

const STATE_TONE = { person: "you", bad: "bad", warn: "warn", ok: "ok", live: "live", none: "none" } as const;
/** How a run ended, when the answer to it is a person's: the step that carries it mounts the need. */
const NEED_ENDINGS = new Set(["waiting", "lapsed", "stopped", "parked"]);

export function RunPage({ model, workspace, selection, select, href }: LineViewProps) {
  // Only the run the address names: one of another process opens once the shell moves to it, never a stand-in.
  const run: LineRunModel | null = useMemo(() => (selection.run ? model.runs.find((x) => x.id === selection.run) ?? null : null), [model.runs, selection.run]);
  const visits = run?.visits ?? [];
  const caseId = run?.caseId ?? selection.case ?? null;
  useSyncTaskSignals(run?.caseId ?? null);

  // The run row itself, for what the model leaves out (sessions, outputs, the failure).
  // The store holds the run (fed by id, or another workspace's) while its floor is still on the way: it is opening, not missing.
  // The held run's task id ("" for none), so a run the line never draws (its task is not a problem) reads as that, not as opening.
  const heldTask = useInboxStore((s) => {
    const r = selection.run ? (s as unknown as { workflowRuns?: Record<string, { task_id?: string }> }).workflowRuns?.[selection.run] : undefined;
    return r ? r.task_id ?? "" : null;
  });
  const heldRun = heldTask !== null;
  const stored = useInboxStore((s) => (run ? ((s as unknown as { workflowRuns?: Record<string, TraceRun> }).workflowRuns?.[run.id] ?? null) : null));
  const raw = (stored ? settledRun(stored) : null) ?? (workspace.rows.runs.find((r) => r._id === run?.id) as TraceRun | undefined) ?? null;
  const task = useMemo(() => (caseId ? (workspace.rows.tasks as unknown as TaskRow[]).find((x) => x._id === caseId) ?? null : null), [workspace.rows.tasks, caseId]);
  const reviews = useMemo(() => reviewsOf(task), [task]);
  const trace = useMemo(() => (run ? runTrace(model, run, raw, { reviews }) : []), [model, run, raw, reviews]);
  const vars = useMemo(() => (run ? runVars(run, raw) : null), [run, raw]);
  const resolve = useCallback((name: string) => (vars ? varValue(name, vars) : null), [vars]);
  const issue = useMemo(() => (caseId ? model.issues.find((i) => i.id === caseId) ?? null : null), [model.issues, caseId]);

  // What waits on a person for this problem (lineNeeds, the one selector), when this run is the one it waits on.
  const need = useMemo(() => needOfCase(workspace.needs ?? [], caseId), [workspace.needs, caseId]);
  const num = useMemo(() => (run ? runNumber(model.runs, run) : { n: 1, of: 1, prev: null, next: null }), [model.runs, run]);
  const newest = num.n === num.of;

  // Where its fix is: the merge and the deploys the problem's history recorded for this run.
  const landing = useMemo((): RunLanding | null => {
    if (!run || !issue) return null;
    const h = issue.history;
    const attempt = h.attempts.find((a) => a.runId === run.id) ?? null;
    const ship = h.ships.find((x) => x.runId === run.id) ?? null;
    const merge = attempt?.merge ?? ship?.merge ?? null;
    if (!merge && !ship) return null;
    const carried = ship?.deploys.length ? Math.min(...ship.deploys.map((d) => d.at)) : null;
    const last = [...h.deploys].sort((a, b) => b.at - a.at)[0] ?? null;
    return { merge, liveAt: carried, coverage: h.coverage.state, lastDeploy: last ? { at: last.at, href: last.url } : null };
  }, [run, issue]);

  // The run ended at its fix decision and nobody answered it: the same reading and words as its problem's band.
  const ended = useMemo(() => {
    const a = run && issue ? issue.history.attempts.find((x) => x.runId === run.id) ?? null : null;
    const e = a && run ? endedAtDecision(a, !!workspace.trialRuns?.has(run.id), run) : null;
    return e?.kind === "unanswered" ? e : null;
  }, [run, issue, workspace.trialRuns]);

  const now = workspace.now;
  // A run's own page reads its history: a card a newer one superseded still belongs to this run.
  const cards = useTrialCards({ all: true });
  // The decision a person step asked, newest first: the rows the workspace holds, the run's own gate, a trial card's.
  const decisionAt = useCallback((node: string): string | null => {
    if (!run) return null;
    const own = (workspace.rows.decisions as unknown as DecisionRow[] | undefined)?.filter((d) => d.workflow_run_id === run.id && d.gate_node_id === node).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
    if (own) return own.short_id ?? own._id;
    const gate = raw as (TraceRun & { gate_node_id?: string }) | null;
    if (gate?.gate_node_id === node && gate.gate_decision_short_id) return gate.gate_decision_short_id;
    const card = cards.find((c) => c.run_id === run.id && c.node_id === node);
    return card?.decision ? card.decision.short_id ?? card.decision._id : null;
  }, [run, raw, cards, workspace.rows.decisions]);
  const askedHere = !!run && run.visits.some((x) => x.kind === "person" && (x.status === "waiting" || x.status === "live") && !!decisionAt(x.node));
  const stop = useMemo(() => (run ? runStop(model, run, raw as ReportRun | null, {
    // A decision this run asked that is not among the viewer's needs is held by someone else (lineNeeds lists only the viewer's).
    holder: need && (need.runId ? need.runId === run.id : newest) && need.counted ? "you" : !need && askedHere ? "other" : null,
    mergedAt: landing?.merge?.at ?? null,
    liveAt: landing?.liveAt ?? null,
    waitsForFindings: /more findings|another finding/i.test(task?.readiness_note ?? "") && !need,
    asksFact: !!need && (need.kind === "question" || need.kind === "confirm"),
    asksYes: need?.kind === "stopped" && need.runId === run.id ? need.ask : null,
    unanswered: ended ? { withdrawn: ended.withdrawn, at: ended.withdrawn ? ended.at : ended.askedAt } : null,
    now,
  }) : null), [model, run, raw, need, newest, landing, task, now, askedHere, ended]);
  const needHere = !!run && !!stop && !!need && NEED_ENDINGS.has(stop.ending) && (need.runId ? need.runId === run.id : newest);

  // The open step: the one the address names, else the step that carries how the run ended.
  const [head, setHead] = useState<{ run: string; i: number } | null>(null);
  const cur = !run || !visits.length || !stop ? 0
    : head?.run === run.id && (selection.step ? visits[head.i]?.node === selection.step : true) ? head.i
    : selection.step ? Math.max(0, visitOf(visits, selection.step, visits.length))
    : stop.at;

  // A step picked is a history entry; the keys walking the trace rewrite the current one.
  const go = useCallback((i: number, cursor = false) => {
    if (!run || !run.visits.length) return;
    const to = Math.max(0, Math.min(run.visits.length - 1, i));
    setHead({ run: run.id, i: to });
    const node = run.visits[to].node;
    if (node !== selection.step) select({ step: node }, undefined, { replace: cursor });
  }, [run, selection.step, select]);

  const toProblem = useCallback((taskId?: string | null) => select({ view: "problems", case: taskId ?? caseId, run: null, step: null }), [select, caseId]);
  const toRun = useCallback((runId: string, taskId: string | null) => select({ view: "problems", run: runId, step: null }, taskId), [select]);

  const rows = useMemo<TraceRow[]>(() => trace.map((s, i) => ({ step: s, mark: (needHere || stop?.cause?.review) && stop && i === stop.at && stop.ending !== "lapsed" ? "waiting" : stepMark(visits[i], s) })), [trace, visits, needHere, stop]);
  const sessions = useMemo(() => [...new Set(trace.filter((t) => t.kind === "agent" && t.session).map((t) => t.session!.id))].slice(0, 12), [trace]);
  const stages = useMemo(() => (run ? stageTrack(run, (node) => model.steps[node]?.stage ?? null, { waiting: stop?.ending === "waiting" }) : []), [run, model.steps, stop?.ending]);

  const ref = run?.caseRef ?? task?.short_id ?? issue?.ref ?? null;
  const crumb = (
    <nav className="rp-crumb" aria-label="Where this run is">
      <button type="button" className="rp-crumb-link" onClick={() => select({ view: "problems", case: null, run: null, step: null })}>Problems</button>
      <span aria-hidden>›</span>
      {caseId ? <button type="button" className="rp-crumb-link rp-mono" onClick={() => toProblem()} data-run-crumb-problem={ref ?? caseId}>{ref ?? "Problem"}</button> : <span className="rp-mono">{ref ?? "No problem"}</span>}
      {run && <><span aria-hidden>›</span><span aria-current="page" data-run-number={num.n}>Run {num.n}</span></>}
    </nav>
  );

  if (!run || !stop) {
    const known = !!selection.run && (heldRun || workspace.rows.runs.some((r) => r._id === selection.run));
    // The line draws only runs on problems: once the feeds have answered, a held run whose task is not one never opens here.
    const offLine = workspace.ready && heldTask !== null && !(workspace.rows.tasks as unknown as TaskRow[]).some((x) => x._id === heldTask && isCause(x));
    return (
      <div className="rp rp-missing" data-line-view="run" data-line-run-missing={selection.run ?? ""} data-line-run-off={offLine ? "" : undefined}>
        {crumb}
        <div className="lw-empty">
          <b>{offLine ? "Not a run on a problem" : known ? "Opening the run" : "This run is not loaded"}</b>
          {offLine && selection.run ? <Link className="lw-act" data-primary="" href={runHref(selection.run)}>Open the run</Link> : caseId ? <button type="button" className="lw-act" onClick={() => toProblem()}>Open its problem</button> : <button type="button" className="lw-act" onClick={() => select({ view: "problems", case: null, run: null, step: null })}>Problems</button>}
        </div>
      </div>
    );
  }

  const v = visits[cur];
  const t = trace[cur];
  const findings = Math.max(task?.cause?.signal_count ?? 0, issue?.findings ?? 0);
  const closed = !!task?.status && isTerminalTaskStatus(task.status);
  const atStop = cur === stop.at;
  const canStart = atStop && newest && !closed && !!caseId && (stop.ending === "failed" || stop.ending === "silent");

  return (
    <div className="rp" data-line-view="run" data-run-ending={stop.ending} data-line-run={run.id}>
      <header className="rp-head">
        <div className="rp-head-top">
          {crumb}
          {num.of > 1 && (
            <span className="rp-runs" data-run-of={num.of}>
              <button type="button" className="rp-step-btn" disabled={!num.prev} aria-label="The run before this one" onClick={() => num.prev && select({ run: num.prev, step: null })}><ChevronLeft className="w-4 h-4" aria-hidden /></button>
              <span className="lw-num">{num.n} of {num.of}</span>
              <button type="button" className="rp-step-btn" disabled={!num.next} aria-label="The run after this one" onClick={() => num.next && select({ run: num.next, step: null })}><ChevronRight className="w-4 h-4" aria-hidden /></button>
            </span>
          )}
          {caseId && findings > 0 && <a className="lw-link rp-findings" href={href({ view: "problems", case: caseId, run: null, step: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); toProblem(); }} data-run-findings={findings}>{findings} {findings === 1 ? "finding" : "findings"}</a>}
        </div>
        <h1 className="rp-title">{issue?.name ?? clauseHeading(issue?.title ?? run.caseTitle) ?? problemTitle(run.caseTitle)}</h1>
        <StageTrack stages={stages} line={{ text: stop.line, tone: STATE_TONE[stop.tone] }} onStage={(step) => { const i = visitOf(visits, step, visits.length); if (i >= 0) go(i); }} />
      </header>
      <BriefPrefetch sessions={sessions} runId={run.id} />

      <div className="rp-body">
        <nav className="rp-trace-wrap" aria-label="Steps">
          <RunTrace rows={rows} cur={cur} onPick={go} />
        </nav>
        <main className="rp-main">
          {v && t ? (
            <RunStep
              key={`${run.id}:${cur}`}
              model={model}
              run={run}
              visit={v}
              trace={t}
              mark={rows[cur].mark}
              onJump={go}
              resolve={resolve}
              need={needHere && atStop ? need : null}
              unanswered={atStop && ended && caseId ? (
                <ClosedDecisionDock decisionRef={ended.ref} state={ended.withdrawn ? "withdrawn" : "lapsed"} taskId={caseId} taskRef={ref} title={run.caseTitle} projectId={task?.project_id ?? null} runId={run.id} askedAt={ended.askedAt} built={ended.built} acts={newest && !closed} />
              ) : null}
              decisionRef={v.kind === "person" || model.steps[v.node]?.kind === "person" ? decisionAt(v.node) : null}
              card={cards.find((c) => c.run_id === run.id && c.node_id === v.node) ?? null}
              names={workspace.names}
              act={canStart ? <StartRunAct icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden />} taskId={caseId!} problem={ref ? `${ref} · ${run.caseTitle}` : run.caseTitle} projectId={task?.project_id ?? null} branch={!!landing?.merge || visits.some((x) => !x.inferred && x.status === "done" && model.steps[x.node]?.stage === "build")} /> : null}
              stepHref={href({ view: "line", step: v.node, run: null, case: null })}
              onOpenStep={() => select({ view: "line", step: v.node, run: null, case: null })}
              onProblem={toProblem}
              onRun={toRun}
              parkedNote={task?.readiness_note ?? null}
              landing={stop.ending === "landed" ? landing : null}
              engineReason={atStop && (stop.ending === "failed" || stop.ending === "silent") ? stop.cause?.raw || (raw as { fail_reason?: string } | null)?.fail_reason || null : null}
            />
          ) : (
            <div className="lw-empty"><b>Not started</b>{run.outcome.text}</div>
          )}
        </main>
      </div>
    </div>
  );
}
