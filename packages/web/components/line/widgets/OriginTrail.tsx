"use client";
// Where a thing on the line came from (ct-68152): one strip from the raw thing
// that happened (a contact's conversation, an error, a person's report) through
// the finding, the problem and its run to the decision. Each stage is a tab:
// pressing it opens that stage in place under the strip (the moment, the
// finding, the problem's own words, the run's stations), and the arrows or the
// arrow keys step through them in order. A decision no line run asked names
// the session that asked it and that session's task instead.
import { memo, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useSyncTaskSignals } from "../../../hooks/useSyncSignals";
import { useInboxStore, useTrackedStore } from "../../../store/inboxStore";
import { useWorkflow, useWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { runPath, type ReportRun, type ReportTask } from "../../../lib/line/runReport";
import { runHref } from "../../../lib/decisionLinks";
import { RunOutcomeText, RunPathView } from "../RunReport";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { FindingReader, useFinderName, type ReaderSignal } from "./FindingReader";
import { MomentView } from "./MomentView";
import { NavLink, useLineNav } from "./parts";
import { sourceName } from "../../../lib/line/sourceNames";
import { entityRoute } from "@codecast/shared/entities";
import "./originTrail.css";

export type OriginTrailProps = {
  /** A decision (its _id): its problem and run, or the session that asked it. */
  decision?: string | null;
  /** A problem (its task _id). */
  task?: string | null;
  /** A finding (its _id): the one opened, else the problem's newest. */
  signal?: string | null;
  /** A moment (mo-N) with no finding behind it yet. */
  moment?: string | null;
  /** Draw the strip only, with the raw thing folded until asked for. */
  folded?: boolean;
  /** Drawn on the problem's own page: the trail stops at the finding. */
  onProblem?: boolean;
};

type Step = { key: string; label: string; ref?: string | null; href?: string | null; onOpen?: () => void; tone?: "raw" | "ask"; panel?: () => ReactNode; stage?: string };

const byNewest = (a: ReaderSignal, b: ReaderSignal) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at);

export const OriginTrail = memo(function OriginTrail({ decision, task: taskProp, signal: signalProp, moment, folded = false, onProblem = false }: OriginTrailProps) {
  const nav = useLineNav();
  const who = useFinderName();
  // Wake on the fields drawn: the decision's state and its problem's title, never the whole collections.
  const taskOf = (st: any): any => { const t = taskProp ?? (decision ? st.sessionDecisions[decision]?.task_id : null); return t ? st.tasks[t] : null; };
  const s = useTrackedStore([
    (st) => { const x = decision ? (st.sessionDecisions as any)[decision] : null; return x ? `${x.status}|${x.task_id ?? ""}|${x.session_title ?? ""}` : null; },
    (st) => { const t = taskOf(st); return t ? `${t._id}|${t.title}|${t.short_id ?? ""}` : null; },
    // A card asked outside the line: the asking session's own work (its bound task, else its plan).
    (st) => { const c = decision ? (st.sessionDecisions as any)[decision]?.conversation_id : null; const x = c ? (st.sessions as any)[c] : null; return x ? `${x.active_task?.short_id ?? ""}|${x.active_plan?.short_id ?? ""}` : null; },
  ]);
  const d = decision ? ((s.sessionDecisions as any)[decision] ?? null) : null;
  const task = taskOf(s);
  const taskId: string | null = taskProp ?? d?.task_id ?? null;
  useSyncTaskSignals(taskId);
  const where = useMemo(() => (taskId ? (r: ReaderSignal) => r.task_id === taskId : signalProp ? (r: ReaderSignal) => r._id === signalProp : () => false), [taskId, signalProp]);
  const signals = useCollectionRows<ReaderSignal>("signals", { where, sig: (r) => `${r._id}|${r.task_id ?? ""}` });
  const sorted = useMemo(() => [...signals].sort(byNewest), [signals]);
  // One finding is one example of a problem's cause: the strip says which, of how many, and steps through them.
  const start = signalProp ? Math.max(0, sorted.findIndex((x) => x._id === signalProp)) : 0;
  const [pick, setPick] = useState<number | null>(null);
  const at = Math.min(pick ?? start, Math.max(0, sorted.length - 1));
  const finding = sorted[at] ?? null;
  const momentRef = finding?.moment ?? moment ?? null;
  // Problems merged into this one: their findings came along (signals.folded_from).
  const merged = useMemo(() => new Set(signals.map((x) => (x as { folded_from?: string }).folded_from).filter(Boolean)).size, [signals]);

  const line = !!(d?.workflow_run_id && d?.task_id) || (!d && !!taskId);
  const runId: string | null = d?.workflow_run_id ?? null;
  const steps: Step[] = [];
  if (d && !line) {
    // A card a session asked: the session is the origin, its task beside it.
    steps.push({ key: "session", label: d.session_title || "A session", href: d.conversation_id ? `/conversation/${d.conversation_id}` : null, tone: "raw" });
    const asker = d.conversation_id ? (s.sessions as any)[d.conversation_id] : null;
    const work = task ? { title: task.title, short_id: task.short_id ?? taskId } : asker?.active_task ?? asker?.active_plan ?? null;
    if (work?.short_id) steps.push({ key: "task", label: work.title, ref: work.short_id, href: entityRoute(work.short_id.startsWith("pl-") ? "plan" : "task", work.short_id) });
  } else {
    // Each stage of the path opens in place under the strip, so the reader
    // steps from the raw thing to the card without leaving the page.
    if (finding) {
      const raw = momentRef ? "Conversation" : finding.subject?.startsWith("eg-") ? "Error" : finding.source === "person" ? "Report" : sourceName(finding.source);
      const reader = () => <FindingReader signal={finding} open onToggle={() => setSel(null)} who={who(finding)} />;
      // A finding on an error or a report reads the raw thing itself, so the two are one stage.
      steps.push({ key: "raw", label: raw, ref: momentRef ?? (finding.subject?.startsWith("eg-") ? finding.subject : null), tone: "raw", panel: momentRef ? () => <MomentView moment={momentRef} /> : reader });
      steps.push({ key: "finding", label: who(finding), ref: finding.short_id, ...(momentRef ? { panel: reader } : { stage: "raw" }) });
    } else if (moment) {
      steps.push({ key: "raw", label: "Conversation", ref: moment, tone: "raw", panel: () => <MomentView moment={moment} /> });
    }
    if (task && !onProblem) {
      const href = nav.caseHref?.(taskId!) ?? (task.short_id ? entityRoute("task", task.short_id) : null);
      steps.push({ key: "problem", label: merged ? `Problem · ${merged + 1} merged` : "Problem", ref: task.short_id, href, onOpen: nav.openCase ? () => nav.openCase!(taskId!) : undefined,
        panel: () => <ProblemPanel taskId={taskId!} findings={sorted.length} /> });
    }
    if (runId) steps.push({ key: "run", label: "Run", href: nav.runHref(runId, taskId) ?? runHref(runId), onOpen: nav.caseHref ? () => nav.openRun(runId, taskId) : undefined,
      panel: () => <RunPanel runId={runId} taskId={taskId} /> });
    if (d) steps.push({ key: "decision", label: d.status === "pending" ? "Asks you" : "Answered", ref: d.short_id, tone: d.status === "pending" ? "ask" : undefined });
  }
  const stages = steps.filter((st) => st.panel);
  const [sel, setSel] = useState<string | null>(folded ? null : stages[0]?.key ?? null);
  const current = stages.find((st) => st.key === sel) ?? null;
  const ci = current ? stages.indexOf(current) : -1;
  const flip = (by: number) => {
    const next = stages[Math.min(stages.length - 1, Math.max(0, (ci < 0 ? (by > 0 ? -1 : stages.length) : ci) + by))];
    if (next) setSel(next.key);
  };
  if (!steps.length) return null;

  return (
    <section className="ot" data-origin-trail data-open={current ? "" : undefined}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); flip(e.key === "ArrowRight" ? 1 : -1); }
        else if (e.key === "Escape" && current) { e.stopPropagation(); setSel(null); }
      }}>
      <ol className="ot-steps" role="tablist" aria-label="Where it came from">
        {steps.map((st, i) => (
          <li key={st.key} className="ot-step" data-tone={st.tone}>
            {i > 0 && <span className="ot-arrow" aria-hidden>→</span>}
            {st.panel || st.stage ? (
              <button type="button" role="tab" aria-selected={sel === (st.stage ?? st.key)} className="ot-btn" data-origin-step={st.key}
                onClick={() => { const k = st.stage ?? st.key; setSel(sel === k ? null : k); }}><StepFace st={st} /></button>
            ) : st.href ? <Link href={st.href} className="ot-btn" data-origin-step={st.key}><StepFace st={st} /></Link>
              : <span className="ot-btn" data-static data-origin-step={st.key}><StepFace st={st} /></span>}
          </li>
        ))}
        {sorted.length > 1 && (
          <li className="ot-step ot-of" data-origin-of>
            <button type="button" className="ot-nav" disabled={at <= 0} onClick={() => { setPick(at - 1); if (!current) setSel("finding"); }} aria-label="Newer finding"><ChevronLeft aria-hidden /></button>
            <span className="ot-count">finding {at + 1} of {sorted.length}</span>
            <button type="button" className="ot-nav" disabled={at >= sorted.length - 1} onClick={() => { setPick(at + 1); if (!current) setSel("finding"); }} aria-label="Older finding"><ChevronRight aria-hidden /></button>
          </li>
        )}
      </ol>
      {current && (
        <div className="ot-panel" role="tabpanel" data-origin-panel={current.key}>
          <div className="ot-panel-head">
            <button type="button" className="ot-nav" disabled={ci <= 0} onClick={() => flip(-1)} aria-label="Previous stage"><ChevronLeft aria-hidden /></button>
            <span className="ot-count">{ci + 1} / {stages.length}</span>
            <button type="button" className="ot-nav" disabled={ci >= stages.length - 1} onClick={() => flip(1)} aria-label="Next stage"><ChevronRight aria-hidden /></button>
            <span className="ot-panel-title">{current.label}{current.ref && <span className="ot-ref">{current.ref}</span>}</span>
            <span className="lw-spacer" />
            {(current.href || current.onOpen) && <NavLink className="ot-all" href={current.href ?? null} onOpen={current.onOpen ?? (() => { if (current.href) window.location.assign(current.href); })}>Open<ArrowUpRight aria-hidden /></NavLink>}
            <button type="button" className="ot-nav" onClick={() => setSel(null)} aria-label="Close"><X aria-hidden /></button>
          </div>
          <div className="ot-panel-body">{current.panel!()}</div>
        </div>
      )}
    </section>
  );
});

/** The problem a run works: its title, how many findings stand behind it, and its own words. */
function ProblemPanel({ taskId, findings }: { taskId: string; findings: number }) {
  const s = useTrackedStore([(st) => { const t = (st.tasks as any)[taskId]; return t ? `${t.title}|${t.status}|${t.description?.length ?? 0}` : null; }]);
  const t = (s.tasks as any)[taskId];
  if (!t) return null;
  return (
    <div className="ot-problem" data-origin-problem>
      <div className="ot-problem-head">
        <span className="ot-problem-title">{t.title}</span>
        <span className="ot-chip">{t.status?.replace(/_/g, " ")}</span>
        {findings > 0 && <span className="ot-chip">{findings} {findings === 1 ? "finding" : "findings"}</span>}
      </div>
      {t.description && <MarkdownRenderer content={t.description} className="ot-problem-body" />}
    </div>
  );
}

/** The run that worked the problem: how it ended and every station it passed, phase by phase. */
function RunPanel({ runId, taskId }: { runId: string; taskId: string | null }) {
  const run = useWorkflowRun(runId) as ReportRun | null | undefined;
  const workflow = useWorkflow((run as any)?.workflow_id);
  const task = useInboxStore((st) => (taskId ? (st.tasks as any)[taskId] : null)) as ReportTask | null;
  const phases = useMemo(() => (run ? runPath(run, workflow, task) : []), [run, workflow, task]);
  if (run === undefined) return <div className="ot-quiet">Loading the run</div>;
  if (run === null) return <div className="ot-quiet">This run is not on this device</div>;
  return (
    <div className="ot-run" data-origin-run>
      <RunOutcomeText run={run} task={task} className="ot-run-outcome" />
      <RunPathView phases={phases} ended={run.status === "completed" || run.status === "failed"} />
    </div>
  );
}

function StepFace({ st }: { st: Step }) {
  return <>
    <span className="ot-label">{st.label}</span>
    {st.ref && <span className="ot-ref">{st.ref}</span>}
  </>;
}
