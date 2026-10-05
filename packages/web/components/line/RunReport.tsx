"use client";
// A run told as a report (the-line-end-to-end.md LE16), in pieces the run
// page, the task page's Line block and the project's Line tab share: the
// outcome sentence, the path in phases, and the runs on one cause. The words
// come from lib/line/runReport, so a run reads the same everywhere.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, ChevronRight, Circle, Hand, Loader2, Pause, X } from "lucide-react";
import { useSyncRuns } from "../../hooks/useSyncRuns";
import { useWorkflowRuns } from "../../hooks/useSyncWorkflows";
import { causeRunEntries, runOutcome, shortDay, type OutcomeTone, type ReportPhase, type ReportRun, type ReportStep, type ReportTask, type StepState } from "../../lib/line/runReport";
import { cn } from "../../lib/utils";
import { runHref } from "../../lib/decisionLinks";

const TONE: Record<OutcomeTone, string> = {
  shipped: "text-sol-green",
  closed: "text-sol-text-muted",
  live: "text-sol-cyan",
  waiting: "text-sol-yellow",
  failed: "text-sol-red",
  calm: "text-sol-text",
};

/** The run's outcome in one sentence, in its tone. `muted` draws a run that
 *  no longer speaks for the cause (a later run followed it): red is kept for
 *  the cause's state now. `brief` is a row's version (runOutcome). */
export function RunOutcomeText({ run, task, className, muted, brief }: { run: ReportRun; task?: ReportTask | null; className?: string; muted?: boolean; brief?: boolean }) {
  const o = runOutcome(run, task, undefined, brief);
  return <span className={cn(muted ? "text-sol-text-dim" : TONE[o.tone], className)} data-run-outcome={o.end ?? run.status}>{o.text}</span>;
}

/** A chip in the outcome row: a link to where the thing lives. */
export function ReportChip({ href, children, title, tone = "default", external }: { href: string; children: ReactNode; title?: string; tone?: "default" | "ship" | "drop" | "revise"; external?: boolean }) {
  const toneCls = tone === "ship" ? "border-sol-green/40 text-sol-green" : tone === "drop" ? "border-sol-red/40 text-sol-red" : tone === "revise" ? "border-sol-yellow/40 text-sol-yellow" : "border-sol-border/50 text-sol-text-muted";
  const cls = cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11.5px] max-w-[22rem] min-w-0 hover:bg-sol-bg-alt transition-colors", toneCls);
  const body = <><span className="truncate">{children}</span>{external && <ArrowUpRight className="w-3 h-3 shrink-0" />}</>;
  return external
    ? <a href={href} target="_blank" rel="noreferrer" className={cls} title={title} data-report-chip>{body}</a>
    : <Link href={href} className={cls} title={title} data-report-chip>{body}</Link>;
}

/** An answer's tone, from its words: Ship, Revise, Drop. */
export const answerTone = (answer: string | null | undefined): "ship" | "drop" | "revise" | "default" =>
  /^ship\b/i.test(answer ?? "") ? "ship" : /^drop\b/i.test(answer ?? "") ? "drop" : /^revise\b/i.test(answer ?? "") ? "revise" : "default";

const STEP_MARK: Record<StepState, { icon: typeof Check; cls: string }> = {
  done: { icon: Check, cls: "text-sol-green" },
  failed: { icon: X, cls: "text-sol-red" },
  live: { icon: Loader2, cls: "text-sol-cyan animate-spin" },
  waiting: { icon: Pause, cls: "text-sol-yellow" },
  noted: { icon: Hand, cls: "text-sol-text-dim" },
};

/** The path a run took, phase by phase: each station's result in one line and
 *  the session that did it; the stations it did not reach fold per phase. */
export function RunPathView({ phases, ended }: { phases: ReportPhase[]; ended: boolean }) {
  return (
    <ol className="space-y-3" data-run-path>
      {phases.map((p) => <PhaseRow key={p.key} phase={p} ended={ended} />)}
    </ol>
  );
}

function PhaseRow({ phase, ended }: { phase: ReportPhase; ended: boolean }) {
  const [open, setOpen] = useState(false);
  const skipped = phase.steps.length === 0;
  const notReached = ended ? "skipped" : "not reached yet";
  // Below sm the phase sits above its steps, so a result gets the row's width.
  return (
    <li className="grid grid-cols-1 sm:grid-cols-[6.5rem_1fr] gap-x-4 gap-y-0.5" data-run-phase={phase.key} data-phase-state={phase.state}>
      <div className={cn("text-[11px] font-semibold uppercase tracking-wider sm:pt-0.5", skipped ? "text-sol-text-dim/60" : phase.state === "failed" ? "text-sol-red" : phase.state === "waiting" ? "text-sol-yellow" : phase.state === "live" ? "text-sol-cyan" : "text-sol-text-dim")}>
        {phase.label}
        {skipped && <span className="sm:hidden ml-2 normal-case tracking-normal font-normal">{notReached}</span>}
      </div>
      <div className="min-w-0">
        {skipped && <div className="hidden sm:block text-[12px] text-sol-text-dim/70 pt-0.5">{notReached}</div>}
        <ul className="space-y-1">
          {phase.steps.map((s, i) => <StepRow key={`${s.id}-${i}`} step={s} />)}
        </ul>
        {!skipped && (phase.folded.length > 0 || phase.routine.length > 0) && (
          <>
            {open && phase.routine.length > 0 && <ul className="mt-1 space-y-1 opacity-75" data-phase-routine>{phase.routine.map((s, i) => <StepRow key={`${s.id}-${i}`} step={s} />)}</ul>}
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted text-left" aria-expanded={open} data-phase-folded={phase.folded.length} data-phase-routine-count={phase.routine.length}>
              <ChevronRight className={cn("w-3 h-3 shrink-0 transition-transform", open && "rotate-90")} />
              {[
                phase.routine.length ? `${phase.routine.length} routine ${phase.routine.length === 1 ? "step" : "steps"}${open ? "" : " passed"}` : "",
                phase.folded.length ? `${phase.folded.length} ${notReached}${open ? `: ${phase.folded.map((f) => f.label).join(", ")}` : ""}` : "",
              ].filter(Boolean).join(" · ")}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

const RESULT_TONE: Record<StepState, string> = { failed: "text-sol-red", waiting: "text-sol-yellow", noted: "text-sol-text-muted", done: "text-sol-text", live: "text-sol-text" };

/** One station's result. The station's name sits in a dim fixed column so
 *  results align; the result links to the session that did it, and a note
 *  says why when the result needs it. */
function StepRow({ step: s }: { step: ReportStep }) {
  const mark = STEP_MARK[s.state];
  const Icon = mark.icon;
  const tone = RESULT_TONE[s.state];
  return (
    <li className="flex items-baseline gap-2 text-[12.5px] min-w-0" data-run-step={s.id} data-step-state={s.state}>
      <Icon className={cn("w-3.5 h-3.5 shrink-0 self-center", mark.cls)} />
      <span className="hidden sm:inline-block w-20 shrink-0 truncate text-[11.5px] text-sol-text-dim" data-step-label>{s.label}</span>
      {s.href ? (
        <Link href={s.href} className={cn("group min-w-0 truncate hover:text-sol-blue hover:underline decoration-sol-blue/40 underline-offset-2", tone)} title={s.hrefTitle} data-step-link>
          {s.result}
          <ArrowUpRight className="inline w-3 h-3 ml-0.5 -mt-0.5 text-sol-text-dim/60 group-hover:text-sol-blue" />
        </Link>
      ) : (
        <span className={cn("min-w-0 truncate", tone)}>{s.result}</span>
      )}
      {s.note && <span className="min-w-0 truncate text-[11.5px] text-sol-text-dim" data-step-note>{s.note}</span>}
    </li>
  );
}

const newestFirst = (a: ReportRun, b: ReportRun) => b.created_at - a.created_at;

/** Feeder and reader: every run on one cause, newest first. */
export function useCauseRuns(taskId: string | null | undefined): ReportRun[] {
  useSyncRuns(taskId ? { task_id: taskId, limit: 20 } : {}, !!taskId);
  const where = useMemo(() => (r: any) => !!taskId && r.task_id === taskId, [taskId]);
  const rows = useWorkflowRuns(where) as ReportRun[];
  return useMemo(() => [...rows].sort(newestFirst), [rows]);
}

/** The runs on a cause, each with its outcome, linked to its report. `current`
 *  marks the run the reader is on; `newest` is the cause's newest run when
 *  `runs` leaves it out. A run a later run followed reads muted, and a streak
 *  of such runs folds into one line. */
export function CauseRunList({ runs, task, current, empty, newest }: { runs: ReportRun[]; task?: ReportTask | null; current?: string; empty?: ReactNode; newest?: number }) {
  const entries = useMemo(() => causeRunEntries(runs, newest), [runs, newest]);
  if (runs.length === 0) return empty ? <>{empty}</> : null;
  return (
    <ul className="divide-y divide-sol-border/20" data-cause-runs>
      {entries.map((e) => e.kind === "folded"
        ? <FoldedRuns key={e.runs[0]._id} runs={e.runs} text={e.text} current={current} />
        // Only the newest run speaks for the cause's state now; an older one says what it came to.
        : <CauseRunRow key={e.run._id} run={e.run} task={e.run === runs[0] && !newest ? task : null} current={current} muted={e.superseded} />)}
    </ul>
  );
}

function CauseRunRow({ run: r, task, current, muted }: { run: ReportRun; task?: ReportTask | null; current?: string; muted?: boolean }) {
  return (
    <li>
      <Link href={runHref(r._id)} className={cn("flex items-baseline gap-3 px-1 py-1.5 text-[12.5px] min-w-0 hover:bg-sol-bg-alt/60 rounded", r._id === current && "bg-sol-bg-alt/50")} data-cause-run={r._id} aria-current={r._id === current ? "page" : undefined}>
        <span className="w-12 shrink-0 text-[11px] text-sol-text-dim tabular-nums">{shortDay(r.created_at)}</span>
        <RunOutcomeText run={r} task={task} muted={muted} brief className="min-w-0 truncate" />
        {r._id === current ? <span className="ml-auto shrink-0 text-[10.5px] text-sol-text-dim">this run</span> : <Circle className="ml-auto w-1.5 h-1.5 shrink-0 text-sol-text-dim/50" />}
      </Link>
    </li>
  );
}

function FoldedRuns({ runs, text, current }: { runs: ReportRun[]; text: string; current?: string }) {
  const [open, setOpen] = useState(() => runs.some((r) => r._id === current));
  return (
    <li data-cause-runs-folded={runs.length}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-baseline gap-3 px-1 py-1.5 text-[12.5px] text-left text-sol-text-dim hover:bg-sol-bg-alt/60 rounded" aria-expanded={open}>
        <span className="w-12 shrink-0 text-[11px] tabular-nums">{shortDay(runs[runs.length - 1].created_at)}</span>
        <span className="min-w-0 truncate">{text}</span>
        <ChevronRight className={cn("ml-auto w-3 h-3 shrink-0 self-center transition-transform", open && "rotate-90")} />
      </button>
      {open && <ul className="pl-4 border-l border-sol-border/30 ml-1">{runs.map((r) => <CauseRunRow key={r._id} run={r} current={current} muted />)}</ul>}
    </li>
  );
}

/** A titled block of a report. */
export function ReportSection({ title, aside, children, id, className }: { title: string; aside?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={cn("scroll-mt-4", className)} data-report-section={title}>
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim">{title}</h2>
        {aside && <span className="ml-auto text-[11px] text-sol-text-dim">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
