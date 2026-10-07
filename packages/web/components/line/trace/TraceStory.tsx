"use client";
// One thing followed through the line, told as a story (docs/architecture/
// line-map.md LX4): a vertical timeline with one step per stage (finding,
// group, cause, ground, each run station by station, card, ship, watch,
// outcome), each saying what happened, when, how long it took and what it
// produced, and for a step with nothing yet what it waits on. The words come
// from lib/line/lineTrace (buildLineTrace), and a run's header and marks are
// RunReport's, so a run reads the same here as on its own page. `compact` is
// the version the map's panel holds.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight, RotateCcw } from "lucide-react";
import { lineTabHref } from "../../../lib/lineSettings";
import { runHref } from "../../../lib/decisionLinks";
import { cn } from "../../../lib/utils";
import { lineTraceHref as traceHref } from "../../../lib/line/lineMapUrl";
import { traceBlocks, type LineTrace, type TraceArtifact, type TraceBlock, type TraceRows, type TraceRunRow, type TraceStatus, type TraceStep } from "../../../lib/line/lineTrace";
import type { ReportRun, StepState } from "../../../lib/line/runReport";
import { ReportChip, RunOutcomeText, StepMark } from "../RunReport";

/** "Sep 16, 2:05 PM": when a step happened. */
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "40m", "2h 5m", "3d 4h", "under a minute": how long a step took, two units at most. */
export function took(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

const STAGE_LABEL: Record<TraceStep["stage"], string> = {
  finding: "Finding", group: "Group", cause: "Cause", ground: "Ground", station: "Run", card: "Card", ship: "Ship", watch: "Watch", outcome: "Outcome",
};

/** The rail's dot: a step that happened is solid, one under way rings, one
 *  that has not happened is hollow. */
export const DOT: Record<TraceStatus, string> = {
  done: "bg-sol-text-muted border-sol-text-muted",
  failed: "bg-sol-red border-sol-red",
  current: "bg-sol-cyan/30 border-sol-cyan animate-pulse",
  waiting: "bg-transparent border-sol-text-dim/60 border-dashed",
  skipped: "bg-transparent border-sol-border",
};
const TITLE_TONE: Record<TraceStatus, string> = {
  done: "text-sol-text", failed: "text-sol-red", current: "text-sol-cyan", waiting: "text-sol-text-muted", skipped: "text-sol-text-dim",
};
/** The outcome's own tone: a held fix is the line's good news. */
const OUTCOME_DOT: Partial<Record<LineTrace["outcome"], string>> = { held: "bg-sol-green border-sol-green", dissolved: "bg-sol-text-dim border-sol-text-dim", dropped: "bg-sol-text-dim border-sol-text-dim" };
const OUTCOME_TONE: Partial<Record<LineTrace["outcome"], string>> = { held: "text-sol-green" };

const STEP_STATE: Record<TraceStatus, StepState> = { done: "done", failed: "failed", current: "live", waiting: "waiting", skipped: "noted" };

export type TraceStoryProps = {
  trace: LineTrace;
  /** The rows the trace was built from: a run's header reads its run, the finding its full words. */
  rows: Pick<TraceRows, "runs" | "signals">;
  /** The panel's version: smaller, the finder's full words and a run's routine steps left out. */
  compact?: boolean;
  /** The map node a hovered step happened at, for the map to light. */
  onFocusNode?: (nodeId: string | null) => void;
};

export function TraceStory({ trace, rows, compact = false, onFocusNode }: TraceStoryProps) {
  const blocks = useMemo(() => traceBlocks(trace), [trace]);
  const runById = useMemo(() => new Map(rows.runs.map((r) => [r._id, r as unknown as ReportRun])), [rows.runs]);
  const runBlocks = blocks.filter((b): b is RunBlockData => b.kind === "run");
  const lastRunId = runBlocks[runBlocks.length - 1]?.runId ?? null;
  const focusSignal = rows.signals.find((s) => s._id === trace.focusSignalId) ?? null;
  const ctx: Ctx = { trace, compact, onFocusNode, projectId: (trace.cause as { project_id?: string }).project_id ?? null };
  return (
    <ol className={cn("relative", compact ? "text-[12px]" : "text-[13px]")} data-trace-story={trace.cause.short_id ?? trace.cause._id} data-trace-outcome={trace.outcome} data-compact={compact ? "" : undefined}>
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        const nextFuture = !last && isFuture(blocks[i + 1]);
        if (b.kind === "run") {
          const run = runById.get(b.runId) ?? null;
          return <RunBlock key={b.runId} block={b} numbered={runBlocks.length > 1} run={run} superseded={b.runId !== lastRunId} last={last} nextFuture={nextFuture} ctx={ctx} />;
        }
        const s = b.step;
        const full = s.stage === "finding" && !compact && focusSignal?.detail_md ? focusSignal.detail_md : null;
        return <StepItem key={s.id} step={s} title={stepTitle(s, trace, focusSignal?.source)} last={last} nextFuture={nextFuture} ctx={ctx} fullWords={full} />;
      })}
    </ol>
  );
}

/** Finders by the names their products use. */
const FINDER_NAMES: Record<string, string> = { agentwatch: "AgentWatch", posthog: "PostHog", sentry: "Sentry", evals: "Evals" };

/** A step's headline, never the cause's title again: the header already
 *  says it. The finding is told as who saw it, the cause as the task it was
 *  filed as, its kind and risk on the line under it (LX4). Every other step keeps its own words. */
export function stepTitle(s: TraceStep, trace: LineTrace, source?: string | null): string {
  const same = s.title.trim() === trace.cause.title.trim();
  if (s.stage === "finding" && same) return `${source ? FINDER_NAMES[source.toLowerCase()] ?? `${source[0].toUpperCase()}${source.slice(1)}` : "A finder"} saw this`;
  if (s.stage === "cause" && same) {
    return `Filed as ${trace.cause.short_id || "a cause"}`;
  }
  return s.title;
}

type Ctx = { trace: LineTrace; compact: boolean; onFocusNode?: (id: string | null) => void; projectId: string | null };

const isFuture = (b: TraceBlock) => b.kind === "step" && (b.step.status === "waiting" || b.step.status === "skipped");

/** One row of the timeline: the rail (a dot and the line down to the next
 *  step, dashed into what has not happened) and the step's body. */
function Rail({ dot, last, dashed, compact }: { dot: string; last: boolean; dashed: boolean; compact: boolean }) {
  return (
    <div className="relative flex justify-center" aria-hidden>
      <span className={cn("relative z-[1] rounded-full border-[1.5px]", compact ? "mt-[5px] w-2 h-2" : "mt-[6px] w-2.5 h-2.5", dot)} />
      {!last && <span className={cn("absolute top-[18px] -bottom-[6px] left-1/2 -translate-x-1/2 w-0 border-l", dashed ? "border-dashed border-sol-border/70" : "border-sol-border")} />}
    </div>
  );
}

function StepItem({ step: s, title, last, nextFuture, ctx, fullWords }: { step: TraceStep; title: string; last: boolean; nextFuture: boolean; ctx: Ctx; fullWords: string | null }) {
  const { trace, compact } = ctx;
  const outcome = s.stage === "outcome";
  const dot = (outcome && OUTCOME_DOT[trace.outcome]) || DOT[s.status];
  const tone = (outcome && OUTCOME_TONE[trace.outcome]) || TITLE_TONE[s.status];
  const future = s.status === "waiting" || s.status === "skipped";
  const [open, setOpen] = useState(false);
  const artifacts = s.artifacts.filter((a) => !(a.kind === "signal" && s.stage === "finding"));
  return (
    <li
      className={cn("grid gap-x-3", compact ? "grid-cols-[12px_1fr] pb-3" : "grid-cols-[14px_1fr] pb-5")}
      data-trace-step={s.stage} data-trace-step-id={s.id} data-trace-status={s.status} data-trace-node={s.nodeId ?? undefined}
      onMouseEnter={ctx.onFocusNode && s.nodeId ? () => ctx.onFocusNode!(s.nodeId) : undefined}
      onMouseLeave={ctx.onFocusNode ? () => ctx.onFocusNode!(null) : undefined}
    >
      <Rail dot={dot} last={last} dashed={nextFuture || future} compact={compact} />
      <div className="min-w-0">
        <StepHead label={STAGE_LABEL[s.stage]} at={s.at} durationMs={s.durationMs} status={s.status} compact={compact} />
        <div className={cn("leading-snug", compact ? "text-[12.5px]" : "text-[14px] font-medium", tone)} data-trace-title>{title}</div>
        {s.detail && <p className={cn("mt-0.5 leading-snug", future ? "text-sol-text-dim" : "text-sol-text-muted", compact && "line-clamp-2")} data-trace-detail>{s.detail}</p>}
        {fullWords && fullWords.trim() !== s.detail && (
          <div className="mt-1">
            <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-[11.5px] text-sol-text-dim hover:text-sol-text-muted" aria-expanded={open} data-trace-finder-words>
              <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
              {open ? "The finder's words" : "Read the finder's words"}
            </button>
            {open && <div className="mt-1 whitespace-pre-wrap rounded-md border border-sol-border/30 bg-sol-bg-alt/40 px-3 py-2 text-[12.5px] leading-relaxed text-sol-text-muted" data-trace-finder-text>{finderText(fullWords)}</div>}
          </div>
        )}
        {(s.links.length > 0 || (!compact && artifacts.length > 0) || (s.stage === "finding" && s.artifacts.length > 0)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {s.links.map((l) => <ReportChip key={l.href} href={l.href} external={l.external}>{l.label}</ReportChip>)}
            {s.stage === "finding" && s.artifacts.filter((a) => a.kind === "signal").map((a) => <span key={a.label} className="text-[11.5px] text-sol-text-dim" data-trace-source>{a.label}</span>)}
            {!compact && s.stage !== "group" && artifacts.map((a) => <ArtifactChip key={`${a.kind}:${a.label}`} a={a} projectId={ctx.projectId} />)}
            {compact && s.stage === "finding" && artifacts.map((a) => <ArtifactChip key={`${a.kind}:${a.label}`} a={a} projectId={ctx.projectId} />)}
          </div>
        )}
        {s.stage === "group" && artifacts.length > 0 && <SiblingList artifacts={artifacts} compact={compact} focusRef={trace.via === "signal" || trace.via === "fingerprint" ? trace.focusId : null} />}
        {s.stage === "watch" && s.status === "failed" && artifacts.length > 0 && compact && <SiblingList artifacts={artifacts} compact />}
      </div>
    </li>
  );
}

/** The step's kicker: its stage, when it happened and how long it took. */
function StepHead({ label, at, durationMs, status, compact, aside }: { label: ReactNode; at: number | null; durationMs: number | null; status: TraceStatus; compact: boolean; aside?: ReactNode }) {
  return (
    <div className={cn("flex items-baseline gap-2 min-w-0", compact ? "text-[10.5px]" : "text-[11px]")}>
      <span className={cn("shrink-0 font-semibold uppercase tracking-wider", status === "failed" ? "text-sol-red" : status === "current" ? "text-sol-cyan" : "text-sol-text-dim")}>{label}</span>
      {at != null && <span className="shrink-0 text-sol-text-dim tabular-nums" data-trace-at>{when(at)}</span>}
      {durationMs != null && durationMs > 0 && <span className="shrink-0 text-sol-text-dim tabular-nums" data-trace-took>{status === "current" ? `${took(durationMs)} so far` : `took ${took(durationMs)}`}</span>}
      {aside && <span className="ml-auto shrink-0">{aside}</span>}
    </div>
  );
}

/** A finder's markdown without its heading marks: the words, not the labels. */
const finderText = (md: string) => md.split("\n").filter((l) => !/^#{1,6}\s/.test(l.trim())).join("\n").trim();

function ArtifactChip({ a, projectId }: { a: TraceArtifact; projectId: string | null }) {
  if (a.kind === "expectation" && a.ref) {
    return projectId
      ? <ReportChip href={`${lineTabHref(projectId)}#${a.ref}`} title="Open this line in the project's expectations">{a.label}</ReportChip>
      : <span className="text-[11.5px] text-sol-text-dim">{a.label}</span>;
  }
  if (a.kind === "signal" && a.ref) return <ReportChip href={traceHref(a.ref)} title="Trace this signal">{a.label}</ReportChip>;
  if (a.href) return <ReportChip href={a.href} external={/^https?:/.test(a.href)}>{a.label}</ReportChip>;
  return <span className="text-[11.5px] text-sol-text-dim">{a.label}</span>;
}

/** The other signals on the cause: each opens its own trace, and links back
 *  to where it was seen. */
function SiblingList({ artifacts, compact, focusRef }: { artifacts: TraceArtifact[]; compact: boolean; focusRef?: string | null }) {
  const shown = compact ? artifacts.slice(0, 3) : artifacts;
  return (
    <ul className="mt-1.5 space-y-0.5" data-trace-siblings>
      {shown.map((a) => (
        <li key={a.ref ?? a.label} className="flex items-baseline gap-2 min-w-0 text-[12px]" data-trace-sibling={a.ref}>
          <span className="w-1 h-1 shrink-0 self-center rounded-full bg-sol-border" aria-hidden />
          {a.ref
            ? <Link href={traceHref(a.ref)} className={cn("min-w-0 truncate hover:text-sol-blue hover:underline decoration-sol-blue/40 underline-offset-2", a.ref === focusRef ? "text-sol-text" : "text-sol-text-muted")} title="Trace this signal">{a.label}</Link>
            : <span className="min-w-0 truncate text-sol-text-muted">{a.label}</span>}
          {a.ref && <span className="shrink-0 font-mono text-[10.5px] text-sol-text-dim">{a.ref}</span>}
          {a.href && <a href={a.href} target="_blank" rel="noreferrer" className="shrink-0 text-sol-text-dim hover:text-sol-blue" title="Where it was seen"><ArrowUpRight className="w-3 h-3" /></a>}
        </li>
      ))}
      {artifacts.length > shown.length && <li className="pl-3 text-[11px] text-sol-text-dim">and {artifacts.length - shown.length} more</li>}
    </ul>
  );
}

// ── a run, station by station ────────────────────────────────────────────────

type RunBlockData = Extract<TraceBlock, { kind: "run" }>;

function RunBlock({ block: b, numbered, run, superseded, last, nextFuture, ctx }: { block: RunBlockData; numbered: boolean; run: ReportRun | null; superseded: boolean; last: boolean; nextFuture: boolean; ctx: Ctx }) {
  const { compact } = ctx;
  const [showRoutine, setShowRoutine] = useState(false);
  const routine = b.rows.filter((r) => r.kind === "station" && r.routine && r.step.status === "done").length;
  const rows = showRoutine ? b.rows : b.rows.filter((r) => !(r.kind === "station" && r.routine && r.step.status === "done"));
  const label = numbered ? `Run ${b.round}` : "Run";
  return (
    <li className={cn("grid gap-x-3", compact ? "grid-cols-[12px_1fr] pb-3" : "grid-cols-[14px_1fr] pb-5")} data-trace-run={b.runId} data-trace-status={b.status} data-trace-rounds={b.rounds}>
      <Rail dot={DOT[b.status]} last={last} dashed={nextFuture} compact={compact} />
      <div className="min-w-0">
        <StepHead
          label={label} at={b.at} durationMs={b.durationMs} status={b.status} compact={compact}
          aside={<Link href={runHref(b.runId)} className="inline-flex items-center gap-0.5 text-sol-text-dim hover:text-sol-blue" data-trace-run-link>Open run<ArrowUpRight className="w-3 h-3" /></Link>}
        />
        {run && <div className={cn("leading-snug", compact ? "text-[12.5px]" : "text-[14px] font-medium")}><RunOutcomeText run={run} muted={superseded} brief={compact} /></div>}
        {b.rounds > 1 && (
          <div className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-sol-yellow" data-trace-loops>
            <RotateCcw className="w-3 h-3" />
            {b.rounds} rounds through build
          </div>
        )}
        <ul className={cn("mt-1.5 rounded-md border border-sol-border/25 bg-sol-bg-alt/20", compact ? "px-2 py-1 space-y-0.5" : "px-2.5 py-1.5 space-y-1")} data-trace-stations>
          {rows.map((r, i) => <RunRow key={r.kind === "station" ? r.step.id : `loop-${i}`} row={r} ctx={ctx} />)}
          {routine > 0 && (
            <li>
              <button type="button" onClick={() => setShowRoutine((o) => !o)} className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted" aria-expanded={showRoutine} data-trace-routine={routine}>
                <ChevronRight className={cn("w-3 h-3 transition-transform", showRoutine && "rotate-90")} />
                {showRoutine ? "Hide the card's routine steps" : `${routine} routine ${routine === 1 ? "step" : "steps"} assembling the card`}
              </button>
            </li>
          )}
        </ul>
      </div>
    </li>
  );
}

const ROW_TONE: Record<TraceStatus, string> = { done: "text-sol-text", failed: "text-sol-red", current: "text-sol-cyan", waiting: "text-sol-yellow", skipped: "text-sol-text-dim" };

function RunRow({ row, ctx }: { row: TraceRunRow; ctx: Ctx }) {
  const { compact } = ctx;
  if (row.kind === "loop") {
    return (
      <li className="flex items-baseline gap-2 min-w-0 text-[12px]" data-trace-loop={row.stations.length} data-trace-status="done">
        <RotateCcw className="w-3.5 h-3.5 shrink-0 self-center text-sol-yellow" aria-hidden />
        <span className="min-w-0">
          <span className="text-sol-text-muted">An earlier round went through {row.stations.length ? row.stations.join(", ") : "build again"}</span>
          {!compact && <span className="block text-[11px] text-sol-text-dim">The line keeps the details of a station's newest visit, so this round shows its path only.</span>}
        </span>
      </li>
    );
  }
  const s = row.step;
  const session = s.artifacts.find((a) => a.kind === "session" || a.kind === "decision");
  return (
    <li
      className="flex items-baseline gap-2 min-w-0 text-[12px]"
      data-trace-station={s.nodeId ?? undefined} data-trace-status={s.status} data-trace-visit={row.visit}
      onMouseEnter={ctx.onFocusNode && s.nodeId ? () => ctx.onFocusNode!(s.nodeId) : undefined}
      onMouseLeave={ctx.onFocusNode ? () => ctx.onFocusNode!(null) : undefined}
    >
      <StepMark state={STEP_STATE[s.status]} className="self-center" />
      <span className={cn("shrink-0 truncate text-sol-text-dim", compact ? "w-16 text-[11px]" : "w-20 text-[11.5px]")} title={s.title}>{s.title}</span>
      <span className={cn("min-w-0", compact ? "truncate" : "", ROW_TONE[s.status])} data-trace-result>{s.detail}</span>
      {row.visit > 1 && <span className="shrink-0 rounded px-1 text-[10.5px] text-sol-yellow border border-sol-yellow/30" title="This station ran again in this run" data-trace-visit-chip>visit {row.visit}</span>}
      <span className="ml-auto shrink-0 flex items-baseline gap-2">
        {!compact && s.durationMs != null && s.durationMs > 0 && <span className="text-[11px] text-sol-text-dim tabular-nums">{took(s.durationMs)}</span>}
        {session?.href && (
          <Link href={session.href} className="inline-flex items-center gap-0.5 text-[11px] text-sol-text-dim hover:text-sol-blue" title={session.label} data-trace-session>
            {session.kind === "decision" ? "card" : "session"}<ArrowUpRight className="w-3 h-3" />
          </Link>
        )}
      </span>
    </li>
  );
}
