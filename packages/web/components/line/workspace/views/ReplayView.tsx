"use client";
// A run's detail (line-workspace.md LW1), read top to bottom like a debugger
// trace: the problem and where it came from (its source, judge, the finding's
// own words, the evidence), then every step the run visited, numbered, and
// the open step's IN, RAN and OUT (ReplayStep). The open step is the address's
// `step` (its newest visit, or the one picked in a loop); ↑ ↓ and j k walk the
// trace, Home and End jump, Esc goes back to the runs (the shell).
import { memo, useCallback, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { decisionId, type LineRunModel } from "../../../../lib/line/lineModel";
import { runEndTone, runEndWords, visitOf } from "../../../../lib/line/replay";
import { runSource, runTrace, runVars, traceTotals, varValue, usdWords, tokenWords, type TraceRun, type TraceSignal, type TraceStep } from "../../../../lib/line/runTrace";
import { cameBackCount } from "../../../../lib/line/timeline";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useStationInput } from "../../../../hooks/useLineWorkspace";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { useInboxStore } from "../../../../store/inboxStore";
import { useCollectionRows } from "../../../../hooks/useCollectionRows";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { backTimes, dayWords, durationWords } from "../../widgets";
import { useMarkRequest, useStepDrafts } from "../stepDrafts";
import { RunSource } from "./replay/RunSource";
import { RunTrace } from "./replay/RunTrace";
import { ReplayStep } from "./replay/ReplayStep";
import type { LineViewProps } from "./types";
import "./replay/replay.css";

const caseSignalSig = (s: TraceSignal) => `${s._id}|${s.task_id}|${s.observed_at}`;

/** Reads every agent step's prompt as the run opens, so IN paints at once when a step is picked. */
const PromptPrefetch = memo(function PromptPrefetch({ trace, runId }: { trace: ReadonlyArray<TraceStep>; runId: string }) {
  const sessions = useMemo(() => [...new Set(trace.filter((t) => t.kind === "agent" && t.session).map((t) => t.session!.id))].slice(0, 12), [trace]);
  return <>{sessions.map((id) => <Prefetch key={id} sessionId={id} runId={runId} />)}</>;
});
function Prefetch({ sessionId, runId }: { sessionId: string; runId: string }) {
  useStationInput(sessionId, runId);
  return null;
}

/** Where a run opens: the step the address names (its newest visit), else where a stopped run stopped, else its first step. */
function openAt(run: LineRunModel, step: string | null): number {
  const vs = run.visits;
  if (step) {
    const j = visitOf(vs, step, vs.length);
    if (j >= 0) return j;
  }
  const end = run.outcome.tone;
  return end === "failed" || end === "stuck" || end === "waiting" || run.live ? Math.max(0, vs.length - 1) : 0;
}

export function ReplayView({ model, workspace, selection, select, drawerOpen = false }: LineViewProps) {
  // Only the run the address names: one of another process opens once the shell moves to it (LineWorkspace), never a stand-in.
  const run: LineRunModel | null = useMemo(() => (selection.run ? model.runs.find((x) => x.id === selection.run) ?? null : null), [model.runs, selection.run]);
  const visits = run?.visits ?? [];

  // The run row itself, for what the model leaves out (sessions, outputs, cost, the failure).
  const raw = useInboxStore((s) => (run ? ((s as unknown as { workflowRuns?: Record<string, TraceRun> }).workflowRuns?.[run.id] ?? null) : null))
    ?? (workspace.rows.runs.find((r) => r._id === run?.id) as TraceRun | undefined) ?? null;
  const trace = useMemo(() => (run ? runTrace(model, run, raw) : []), [model, run, raw]);
  const totals = useMemo(() => traceTotals(trace), [trace]);
  const vars = useMemo(() => (run ? runVars(run, raw) : null), [run, raw]);
  const resolve = useCallback((name: string) => (vars ? varValue(name, vars) : null), [vars]);
  // Every finding linked to the problem, not only those the floor's window holds: the case's own feed (useSyncTaskSignals) brings the older ones.
  const caseWhere = useMemo(() => (s: TraceSignal) => !!run?.caseId && s.task_id === run.caseId, [run?.caseId]);
  const caseSignals = useCollectionRows<TraceSignal>("signals", { where: caseWhere, sig: caseSignalSig });
  const source = useMemo(() => runSource([...(workspace.rows.signals as ReadonlyArray<TraceSignal>), ...caseSignals], run?.caseId ?? null, run?.at ?? null), [caseSignals, workspace.rows.signals, run?.caseId, run?.at]);

  // The open visit: one picked here (a loop's earlier round), else the address's step.
  const [head, setHead] = useState<{ run: string; i: number } | null>(null);
  const cur = !run || !visits.length ? 0
    : head?.run === run.id && visits[head.i]?.node === selection.step ? head.i
    : openAt(run, selection.step);

  const go = useCallback((i: number) => {
    if (!run || !run.visits.length) return;
    const to = Math.max(0, Math.min(run.visits.length - 1, i));
    setHead({ run: run.id, i: to });
    const node = run.visits[to].node;
    if (node !== selection.step) select({ step: node });
  }, [run, selection.step, select]);

  // Another view asked for this run at a step (the Timeline's close that did not hold): open it there.
  // The local head moves during render; the address follows after commit.
  const ask = useMarkRequest();
  const [seenAsk, setSeenAsk] = useState(0);
  if (ask && ask.n !== seenAsk && run && ask.run === run.id) {
    setSeenAsk(ask.n);
    const j = visitOf(visits, ask.step, visits.length - 1);
    if (j >= 0 && j !== cur) setHead({ run: run.id, i: j });
  }
  const askedStep = ask && run && ask.run === run.id ? ask.step : null;
  useWatchEffect(() => { if (askedStep && askedStep !== selection.step) select({ step: askedStep }); }, [ask?.n]);

  const [rerun, setRerun] = useState<{ run: string; node: string } | null>(null);

  // Keys: ↑ ↓ and j k walk the trace, Home and End jump (the drawer takes the arrows when it is open).
  const active = useTabActive();
  useWatchEffect(() => {
    if (!active || drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const k = e.key;
      if (k === "ArrowDown" || k === "j" || k === "ArrowRight") { e.preventDefault(); go(cur + 1); }
      else if (k === "ArrowUp" || k === "k" || k === "ArrowLeft") { e.preventDefault(); go(cur - 1); }
      else if (k === "Home") { e.preventDefault(); go(0); }
      else if (k === "End") { e.preventDefault(); go(visits.length - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, drawerOpen, go, cur, visits.length]);

  const openStep = useCallback((id: string) => select({ step: id }), [select]);
  const onFindings = useMemo(() => (run?.caseId ? () => select({ view: "problems", case: run.caseId }) : null), [run?.caseId, select]);
  const onSource = useCallback((name: string) => select({ view: "sources", source: name }), [select]);

  // Decisions on this run someone marked wrong, and steps with an unsaved edit.
  const wrong = useMemo(() => {
    const s = new Set<string>();
    if (run) for (const v of run.visits) if (model.steps[v.node]?.decisions.find((d) => d.id === decisionId(run.id, v.node))?.label?.verdict === "wrong") s.add(v.node);
    return s;
  }, [model.steps, run]);
  const drafts = useStepDrafts();
  const drafted = useMemo(() => new Set(Object.keys(drafts)), [drafts]);

  if (!run) {
    const known = selection.run && workspace.rows.runs.some((r) => r._id === selection.run);
    return (
      <div className="lw-empty" data-line-view="replay" data-line-run-missing={selection.run ?? ""}>
        <b>{known ? "Opening run" : "Run not loaded"}</b>
        <button type="button" className="lw-act" onClick={() => select({ run: null, step: null })}>All runs</button>
      </div>
    );
  }
  const v = visits[cur];
  const t = trace[cur];
  const issue = run.caseId ? model.issues.find((i) => i.id === run.caseId) : null;
  const backN = issue ? cameBackCount(issue.history) : 0;
  // What the problem held when this run started: its recorded findings up to then, never the ones after.
  // The cause's own count when every finding it holds came before the run: the number its steps were told.
  // The cause's own count, less the findings known to have come after the start: the number its steps were told.
  const cause = (workspace.rows.tasks as Array<{ _id: string; cause?: { signal_count: number; first_seen: number } | null }>).find((x) => x._id === run.caseId)?.cause;
  const atStart = Math.max(source.count, issue ? issue.history.occurrences.filter((o) => o.at <= run.at).length : 0, cause && cause.first_seen <= run.at ? cause.signal_count - source.later : 0);
  const end = runEndWords(run);
  const took = durationWords(run.durationMs);

  return (
    <div className="rd" data-line-view="replay" data-drawer={drawerOpen ? "" : undefined}>
      <header className="rd-head">
        <button type="button" className="rd-back" onClick={() => select({ run: null, step: null })} title="Back to runs (Esc)"><ArrowLeft className="w-3.5 h-3.5" aria-hidden />Runs</button>
        <div className="rd-head-main">
          <div className="rd-head-title">
            {run.caseRef && (run.caseId
              ? <button type="button" className="rd-ref" onClick={() => select({ view: "problems", case: run.caseId })} title="The problem's timeline">{run.caseRef}</button>
              : <span className="rd-ref">{run.caseRef}</span>)}
            <h1 title={run.caseTitle}>{run.caseTitle}</h1>
          </div>
          <div className="rd-stats">
            <span className="lw-oc" data-tone={runEndTone(end)} data-end={end}>{end}</span>
            {backN > 0 && <span className="rd-stat" data-tone="bad">came back {backTimes(backN)}</span>}
            <span className="rd-stat">{dayWords(run.at)}</span>
            {took && <span className="rd-stat"><i>took</i>{took}</span>}
            <span className="rd-stat"><i>steps</i>{visits.length}</span>
            {totals.agent > 0 && <span className="rd-stat"><i>agents</i>{totals.agent}</span>}
            {totals.person > 0 && <span className="rd-stat"><i>people</i>{totals.person}</span>}
            {totals.tokens > 0 && <span className="rd-stat"><i>tok</i>{tokenWords(totals.tokens)}</span>}
            {totals.costUsd > 0 && <span className="rd-stat">{usdWords(totals.costUsd)}</span>}
          </div>
        </div>
      </header>

      <RunSource source={source} expected={atStart} known={run.caseId ? workspace.sources.get(run.caseId) : undefined} title={run.caseTitle} onFindings={onFindings} onSource={onSource} />
      <PromptPrefetch trace={trace} runId={run.id} />

      <div className="rd-body">
        <nav className="rd-trace-wrap" aria-label="Steps">
          <RunTrace steps={trace} cur={cur} wrong={wrong} drafted={drafted} onPick={go} />
        </nav>
        <main className="rd-inspector">
          {v && t ? (
            <ReplayStep
              key={`${run.id}:${cur}`}
              model={model}
              run={run}
              visit={v}
              trace={t}
              openStep={openStep}
              onJump={go}
              resolve={resolve}
              rerunning={rerun?.run === run.id && rerun.node === v.node}
              setRerunning={(on) => setRerun(on ? { run: run.id, node: v.node } : null)}
            />
          ) : (
            <div className="lw-empty"><b>Not started</b>{run.outcome.text}</div>
          )}
        </main>
      </div>
    </div>
  );
}
