"use client";
// A run told as a report (the-line-end-to-end.md LE16), in pieces the run
// page, the task page's Line block and the project's Line tab share: the
// outcome sentence, the path in phases, and the runs on one cause. The words
// come from lib/line/runReport, so a run reads the same everywhere.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, ChevronRight, Circle, Loader2, Pause, X } from "lucide-react";
import { useSyncRuns } from "../../hooks/useSyncRuns";
import { useWorkflowRuns } from "../../hooks/useSyncWorkflows";
import { runOutcome, type OutcomeTone, type ReportPhase, type ReportRun, type ReportTask, type StepState } from "../../lib/line/runReport";
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

/** The run's outcome in one sentence, in its tone. */
export function RunOutcomeText({ run, task, className }: { run: ReportRun; task?: ReportTask | null; className?: string }) {
  const o = runOutcome(run, task);
  return <span className={cn(TONE[o.tone], className)} data-run-outcome={o.end ?? run.status}>{o.text}</span>;
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
  return (
    <li className="grid grid-cols-[6.5rem_1fr] gap-x-4" data-run-phase={phase.key} data-phase-state={phase.state}>
      <div className={cn("text-[11px] font-semibold uppercase tracking-wider pt-0.5", skipped ? "text-sol-text-dim/60" : phase.state === "failed" ? "text-sol-red" : phase.state === "waiting" ? "text-sol-yellow" : phase.state === "live" ? "text-sol-cyan" : "text-sol-text-dim")}>
        {phase.label}
      </div>
      <div className="min-w-0">
        {skipped && <div className="text-[12px] text-sol-text-dim/70 pt-0.5">{notReached}</div>}
        <ul className="space-y-1">
          {phase.steps.map((s, i) => {
            const mark = STEP_MARK[s.state];
            const Icon = mark.icon;
            return (
              <li key={`${s.id}-${i}`} className="flex items-baseline gap-2 text-[12.5px] min-w-0" data-run-step={s.id} data-step-state={s.state}>
                <Icon className={cn("w-3.5 h-3.5 shrink-0 self-center", mark.cls)} />
                <span className="text-sol-text-muted shrink-0">{s.label}</span>
                <span className={cn("min-w-0 truncate", s.state === "failed" ? "text-sol-red" : s.state === "waiting" ? "text-sol-yellow" : "text-sol-text")}>{s.result}</span>
                {s.session && (
                  <Link href={s.session.href} className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[11px] text-sol-text-dim hover:text-sol-blue" title={s.session.title ? `Open the session: ${s.session.title}` : "Open the session that did this"} data-step-session>
                    session <ArrowUpRight className="w-3 h-3" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
        {!skipped && phase.folded.length > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted" aria-expanded={open} data-phase-folded={phase.folded.length}>
            <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
            {phase.folded.length} {notReached}{open ? `: ${phase.folded.map((f) => f.label).join(", ")}` : ""}
          </button>
        )}
      </div>
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

const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The runs on a cause, each with its outcome, linked to its report. `current`
 *  marks the run the reader is on. */
export function CauseRunList({ runs, task, current, empty }: { runs: ReportRun[]; task?: ReportTask | null; current?: string; empty?: ReactNode }) {
  if (runs.length === 0) return empty ? <>{empty}</> : null;
  return (
    <ul className="divide-y divide-sol-border/20" data-cause-runs>
      {runs.map((r, i) => (
        <li key={r._id}>
          <Link href={runHref(r._id)} className={cn("flex items-baseline gap-3 px-1 py-1.5 text-[12.5px] min-w-0 hover:bg-sol-bg-alt/60 rounded", r._id === current && "bg-sol-bg-alt/50")} data-cause-run={r._id} aria-current={r._id === current ? "page" : undefined}>
            <span className="w-12 shrink-0 text-[11px] text-sol-text-dim tabular-nums">{when(r.created_at)}</span>
            {/* Only the newest run speaks for the cause's state now; an older one says what it came to. */}
            <RunOutcomeText run={r} task={i === 0 ? task : null} className="min-w-0 truncate" />
            {r._id === current ? <span className="ml-auto shrink-0 text-[10.5px] text-sol-text-dim">this run</span> : <Circle className="ml-auto w-1.5 h-1.5 shrink-0 text-sol-text-dim/50" />}
          </Link>
        </li>
      ))}
    </ul>
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
