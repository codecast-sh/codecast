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
import { ArrowRight, ArrowUpRight, ChevronRight, CircleStop, RotateCcw } from "lucide-react";
import { lineTabHref } from "../../../lib/lineSettings";
import { runHref } from "../../../lib/decisionLinks";
import { cn } from "../../../lib/utils";
import { lineTraceHref as traceHref } from "../../../lib/line/lineMapUrl";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { finderName, replacedWords, runEndTone, traceBlocks, type LineTrace, type TraceTone, type TraceArtifact, type TraceBlock, type TraceRows, type TraceRun, type TraceRunRow, type TraceStatus, type TraceStep } from "../../../lib/line/lineTrace";
import { isGateNode, runOutcome, type ReportRun, type StepState } from "../../../lib/line/runReport";
import { useProjectExpectations, useSyncProjectExpectations } from "../../../hooks/useSyncProjectExpectations";
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

/** The rail's dot, and the path strip's: a step that passed is green, one
 *  that stopped is red, one under way rings blue, one that has not happened
 *  is hollow, and a replaced run (it passed, and its change was thrown away)
 *  is a muted ring, never a pass's green. One set of tokens, so the strip and
 *  the story read as one (lineTrace runEndTone). */
export const DOT: Record<TraceTone, string> = {
  replaced: "bg-sol-text-dim/15 border-sol-text-muted",
  done: "bg-sol-green border-sol-green",
  failed: "bg-sol-red border-sol-red",
  current: "bg-sol-blue/30 border-sol-blue animate-pulse",
  waiting: "bg-transparent border-sol-text-dim/60 border-dashed",
  skipped: "bg-transparent border-sol-border",
  noted: "bg-sol-text-dim/50 border-sol-text-dim/70",
};
const TITLE_TONE: Record<TraceStatus, string> = {
  done: "text-sol-text", failed: "text-sol-red", current: "text-sol-blue", waiting: "text-sol-text-muted", skipped: "text-sol-text-dim", noted: "text-sol-text-muted",
};
/** The outcome's own tone: a held fix is the line's good news. */
const OUTCOME_DOT: Partial<Record<LineTrace["outcome"], string>> = { held: "bg-sol-green border-sol-green", dissolved: "bg-sol-text-dim border-sol-text-dim", dropped: "bg-sol-text-dim border-sol-text-dim" };
const OUTCOME_TONE: Partial<Record<LineTrace["outcome"], string>> = { held: "text-sol-green" };

const STEP_STATE: Record<TraceStatus, StepState> = { done: "done", failed: "failed", current: "live", waiting: "waiting", skipped: "noted", noted: "noted" };

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
  const endById = useMemo(() => new Map(trace.runs.map((r) => [r.runId, r])), [trace.runs]);
  const repeats = useMemo(() => runRepeats(blocks, runById, endById), [blocks, runById, endById]);
  // A step in the same minute as the one before it leaves its time unsaid (Finding, Group and Cause often share one).
  const sameMinute = useMemo(() => {
    const out = new Set<number>();
    let prev: number | null = null;
    blocks.forEach((b, i) => {
      const at = b.kind === "run" ? b.at : b.step.at;
      if (at == null) return;
      const m = Math.floor(at / 60_000);
      if (m === prev && b.kind === "step") out.add(i);
      prev = m;
    });
    return out;
  }, [blocks]);
  return (
    <ol className={cn("relative", compact ? "text-[12px]" : "text-[13px]")} data-trace-story={trace.cause.short_id ?? trace.cause._id} data-trace-outcome={trace.outcome} data-compact={compact ? "" : undefined}>
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        const nextFuture = !last && isFuture(blocks[i + 1]);
        if (b.kind === "run") {
          const rep = repeats.get(b.runId);
          // A run folded into the one before it is told there.
          if (rep?.into) return null;
          const run = runById.get(b.runId) ?? null;
          return <RunBlock key={b.runId} block={b} numbered={runBlocks.length > 1} run={run} superseded={b.runId !== lastRunId && !rep?.rounds.includes(runBlocks[runBlocks.length - 1]?.round ?? -1)} last={last} nextFuture={nextFuture} ctx={ctx} rounds={rep?.rounds} sameAs={rep?.sameAs} end={endById.get(b.runId)} />;
        }
        const s = b.step;
        const full = s.stage === "finding" && !compact && focusSignal?.detail_md ? focusSignal.detail_md : null;
        const words = s.stage === "ground" ? groundWords(s) : null;
        return <StepItem key={s.id} step={words ? { ...s, detail: words.detail } : s} title={words?.title ?? stepTitle(s, trace, focusSignal?.source)} last={last} nextFuture={nextFuture} ctx={ctx} fullWords={full} hideAt={sameMinute.has(i)} />;
      })}
    </ol>
  );
}

/** A step's headline, never the cause's title again: the header already
 *  says it. The finding is told as who saw it, the cause as the task it was
 *  filed as, its kind and risk on the line under it (LX4). Every other step keeps its own words. */
export function stepTitle(s: TraceStep, trace: LineTrace, source?: string | null): string {
  const same = s.title.trim() === trace.cause.title.trim();
  if (s.stage === "finding" && same) return `${finderName(source)} saw this`;
  if (s.stage === "cause" && same) {
    return `Filed as ${trace.cause.short_id || "a cause"}`;
  }
  return s.title;
}

/** Ground's step titled with what it concluded, never its own stage name
 *  again: the goal it serves and, when the note gives one, the size of the
 *  fix ("Serves Matching Engine & Funnel; fix is a two-line rewrite of the
 *  intro occasion prompt"). The rest of the note is the body. A cause not grounded
 *  yet says so. */
export function groundWords(s: Pick<TraceStep, "status" | "detail">): { title: string; detail: string } {
  const detail = s.detail ?? "";
  if (s.status === "waiting") return { title: "Not grounded yet", detail };
  const m = /^(Serves [^.]+)(?:\.\s+([\s\S]*))?$/.exec(detail.trim());
  if (!m) {
    // No goal named: its first sentence is the title, the rest the body.
    const cut = detail.search(/[.;]\s/);
    return cut < 0 ? { title: detail || "Grounded", detail: "" } : { title: detail.slice(0, cut), detail: detail.slice(cut + 2) };
  }
  const note = (m[2] ?? "").trim();
  const semi = note.lastIndexOf(";");
  if (semi < 0) return { title: m[1], detail: note };
  // The fix clause moves to the title; the body keeps the rest of the note, so nothing is said twice.
  const [fix, ...after] = note.slice(semi + 1).split(",");
  const rest = after.join(",").trim();
  return { title: `${m[1]}; ${fix.trim()}`, detail: `${note.slice(0, semi).trim()}${rest ? `; ${rest}` : ""}` };
}

/** Runs that ended the same way through the same steps. A run right after
 *  its twin folds into it ("Runs 1 and 2"); a later one says which run it
 *  repeats and keeps its steps folded, so six runs read as what differed.
 *  Replaced runs (LX4) are twins by their end alone: each passed its steps
 *  and lost its card to a newer run, which is the part worth reading. */
type RunRepeat = { rounds: number[]; into?: string; sameAs?: number };
function runRepeats(blocks: TraceBlock[], runById: Map<string, ReportRun>, endById: Map<string, TraceRun>): Map<string, RunRepeat> {
  const out = new Map<string, RunRepeat>();
  const firstBySig = new Map<string, number>();
  let prev: { runId: string; sig: string } | null = null;
  for (const b of blocks) {
    if (b.kind !== "run") { prev = null; continue; }
    const run = runById.get(b.runId);
    // A live run is still writing its story; it never folds.
    if (!run || b.status === "current") { prev = null; continue; }
    const sig = endById.get(b.runId)?.end === "replaced" ? "replaced" : [runOutcome(run, null, 0, true).text, ...b.rows.flatMap((r) => (r.kind === "station" && !r.routine ? [`${r.step.nodeId}|${r.step.status}|${r.step.detail}`] : []))].join("\n");
    if (prev && prev.sig === sig) {
      out.get(prev.runId)!.rounds.push(b.round);
      out.set(b.runId, { rounds: [b.round], into: prev.runId });
      continue;
    }
    const seen = firstBySig.get(sig);
    out.set(b.runId, { rounds: [b.round], ...(seen != null ? { sameAs: seen } : {}) });
    if (seen == null) firstBySig.set(sig, b.round);
    prev = { runId: b.runId, sig };
  }
  return out;
}

const roundsWords = (r: number[]) => (r.length === 2 ? `${r[0]} and ${r[1]}` : `${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}`);

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

function StepItem({ step: s, title, last, nextFuture, ctx, fullWords, hideAt }: { step: TraceStep; title: string; last: boolean; nextFuture: boolean; ctx: Ctx; fullWords: string | null; hideAt?: boolean }) {
  const { trace, compact } = ctx;
  const outcome = s.stage === "outcome";
  const dot = (outcome && OUTCOME_DOT[trace.outcome]) || DOT[s.status];
  const tone = (outcome && OUTCOME_TONE[trace.outcome]) || TITLE_TONE[s.status];
  const future = s.status === "waiting" || s.status === "skipped";
  const [open, setOpen] = useState(false);
  const artifacts = s.artifacts.filter((a) => !(a.kind === "signal" && s.stage === "finding"));
  // The page is the cause's own trace, so its step does not link to it again;
  // the other causes a group names read as a list of titles, below.
  const links = s.stage === "group" || (s.stage === "cause" && !compact) ? [] : s.links;
  // The finding's source and kind are meta on its time line; its two links
  // (where it was seen, the expectation it breaks) read as text links (LX4, LX7).
  const finding = s.stage === "finding";
  const meta = finding ? s.artifacts.find((a) => a.kind === "signal")?.label ?? null : null;
  const breaks = finding ? s.artifacts.find((a) => a.kind === "expectation" && a.ref) ?? null : null;
  return (
    <li
      className={cn("grid gap-x-3", compact ? "grid-cols-[12px_1fr] pb-3" : "grid-cols-[14px_1fr] pb-5")}
      data-trace-step={s.stage} data-trace-step-id={s.id} data-trace-status={s.status} data-trace-node={s.nodeId ?? undefined}
      onMouseEnter={ctx.onFocusNode && s.nodeId ? () => ctx.onFocusNode!(s.nodeId) : undefined}
      onMouseLeave={ctx.onFocusNode ? () => ctx.onFocusNode!(null) : undefined}
    >
      <Rail dot={dot} last={last} dashed={nextFuture || future} compact={compact} />
      <div className="min-w-0">
        <StepHead label={STAGE_LABEL[s.stage]} at={hideAt ? null : s.at} durationMs={s.durationMs} status={s.status} compact={compact} meta={meta} />
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
        {finding && (links.length > 0 || breaks) && (
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1" data-trace-finding-links>
            {links.map((l) => <TextLink key={l.href} href={l.href} external={l.external}>{l.label}</TextLink>)}
            {breaks && <BreaksLink id={breaks.ref!} projectId={ctx.projectId} />}
          </div>
        )}
        {!finding && (links.length > 0 || (!compact && artifacts.length > 0)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {links.map((l) => <ReportChip key={l.href} href={l.href} external={l.external}>{l.label}</ReportChip>)}
            {!compact && s.stage !== "group" && artifacts.map((a) => <ArtifactChip key={`${a.kind}:${a.label}`} a={a} projectId={ctx.projectId} />)}
          </div>
        )}
        {s.stage === "group" && s.links.length > 0 && (
          <ul className="mt-1.5 space-y-0.5" data-trace-other-causes>
            {s.links.map((l) => (
              <li key={l.href} className="flex items-baseline gap-2 min-w-0 text-[12px]" data-trace-other-cause={l.ref}>
                <span className="w-1 h-1 shrink-0 self-center rounded-full bg-sol-border" aria-hidden />
                <Link href={l.href} className="min-w-0 truncate text-sol-text-muted hover:text-sol-blue hover:underline decoration-sol-blue/40 underline-offset-2" title={`Trace ${l.ref ?? "this cause"}`}>{l.label}</Link>
                {l.ref && <span className="shrink-0 text-[11px] text-sol-text-dim" data-trace-other-cause-where><span className="font-mono text-[10.5px]">{l.ref}</span>{l.note ? `, ${l.note}` : ""}</span>}
              </li>
            ))}
          </ul>
        )}
        {s.stage === "group" && artifacts.length > 0 && <SiblingList artifacts={artifacts} compact={compact} focusRef={trace.via === "signal" || trace.via === "fingerprint" ? trace.focusId : null} />}
        {s.stage === "watch" && s.status === "failed" && artifacts.length > 0 && compact && <SiblingList artifacts={artifacts} compact />}
      </div>
    </li>
  );
}

/** The step's kicker: its stage, when it happened, how long it took, and plain meta (a finding's source and kind). */
function StepHead({ label, at, durationMs, status, compact, aside, meta }: { label: ReactNode; at: number | null; durationMs: number | null; status: TraceStatus; compact: boolean; aside?: ReactNode; meta?: string | null }) {
  return (
    <div className={cn("flex items-baseline gap-2 min-w-0", compact ? "text-[10.5px]" : "text-[11px]")}>
      <span className={cn("shrink-0 font-semibold uppercase tracking-wider", status === "failed" ? "text-sol-red" : status === "current" ? "text-sol-blue" : "text-sol-text-dim")}>{label}</span>
      {at != null && <span className="shrink-0 text-sol-text-dim tabular-nums" data-trace-at>{when(at)}</span>}
      {durationMs != null && durationMs > 0 && <span className="shrink-0 text-sol-text-dim tabular-nums" data-trace-took>{status === "current" ? `${took(durationMs)} so far` : `took ${took(durationMs)}`}</span>}
      {meta && <span className="min-w-0 truncate text-sol-text-dim" data-trace-source>{meta}</span>}
      {aside && <span className="ml-auto shrink-0">{aside}</span>}
    </div>
  );
}

/** A quiet text link with its arrow: out of the app (external) or to another page here. */
function TextLink({ href, external, out, title, children }: { href: string; external?: boolean; out?: boolean; title?: string; children: ReactNode }) {
  const cls = "inline-flex items-baseline gap-0.5 min-w-0 text-[11.5px] text-sol-text-muted hover:text-sol-blue hover:underline decoration-sol-blue/40 underline-offset-2";
  const body = <><span className="min-w-0 truncate">{children}</span>{external || out ? <ArrowUpRight className="w-3 h-3 shrink-0 self-center" /> : <ArrowRight className="w-3 h-3 shrink-0 self-center" />}</>;
  return external
    ? <a href={href} target="_blank" rel="noreferrer" className={cls} title={title} data-trace-link>{body}</a>
    : <Link href={href} className={cls} title={title} data-trace-link>{body}</Link>;
}

/** The expectation a finding breaks, named by its own sentence from the
 *  project's expectations (the store), never by its id; the id waits in the tooltip. */
function BreaksLink({ id, projectId }: { id: string; projectId: string | null }) {
  useSyncProjectExpectations(projectId);
  const row = useProjectExpectations(projectId);
  const text = row?.doc?.items.find((e) => e.id === id)?.text?.trim().replace(/[.\s]+$/, "") ?? null;
  // The sentence's head is its short label ("An introduction email reaches both people and gives each what they need to act").
  const label = text ? text.split(/[:;]\s/)[0].trim() : null;
  const words = label ? `Breaks: ${label}` : "Breaks an expectation";
  if (!projectId) return <span className="text-[11.5px] text-sol-text-dim" title={id} data-trace-breaks={id}>{words}</span>;
  return <span data-trace-breaks={id} className="min-w-0 max-w-full inline-flex"><TextLink href={`${lineTabHref(projectId)}#${id}`} title={`${text ?? "This expectation"} (${id}). Open it in the project's expectations`}>{words}</TextLink></span>;
}

/** A finder's markdown without its heading marks: the words, not the labels. */
const finderText = (md: string) => md.split("\n").filter((l) => !/^#{1,6}\s/.test(l.trim())).join("\n").trim();

function ArtifactChip({ a, projectId }: { a: TraceArtifact; projectId: string | null }) {
  // A session or a card opens elsewhere in the app: a text link with its arrow, like every other link on the page.
  if ((a.kind === "session" || a.kind === "decision") && a.href) return <TextLink href={a.href} out title={a.label}>{a.kind === "session" ? "Session" : "Card"}</TextLink>;
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

function RunBlock({ block: b, numbered, run, superseded, last, nextFuture, ctx, rounds, sameAs, end }: { block: RunBlockData; numbered: boolean; run: ReportRun | null; superseded: boolean; last: boolean; nextFuture: boolean; ctx: Ctx; rounds?: number[]; sameAs?: number; end?: TraceRun }) {
  const { compact } = ctx;
  const [showRoutine, setShowRoutine] = useState(false);
  // A repeat of an earlier run keeps its steps folded until asked.
  const [showSteps, setShowSteps] = useState(sameAs == null);
  const routine = b.rows.filter((r) => r.kind === "station" && r.routine && r.step.status === "done").length;
  const rows = showRoutine ? b.rows : b.rows.filter((r) => !(r.kind === "station" && r.routine && r.step.status === "done"));
  const many = (rounds?.length ?? 0) > 1;
  const label = many ? `Runs ${roundsWords(rounds!)}` : numbered ? `Run ${b.round}` : "Run";
  // A replaced run passed its steps and lost its change: its own dot, and its headline says what happened to the card.
  const replaced = end?.end === "replaced" ? end : null;
  return (
    <li className={cn("grid gap-x-3", compact ? "grid-cols-[12px_1fr] pb-3" : "grid-cols-[14px_1fr] pb-5")} data-trace-run={b.runId} data-trace-status={b.status} data-trace-rounds={b.rounds}>
      <Rail dot={DOT[runEndTone(end?.end, b.status)]} last={last} dashed={nextFuture} compact={compact} />
      <div className="min-w-0">
        <StepHead
          label={label} at={b.at} durationMs={b.durationMs} status={b.status} compact={compact}
          aside={<Link href={runHref(b.runId)} className="inline-flex items-center gap-0.5 text-sol-text-dim hover:text-sol-blue" data-trace-run-link>Open run<ArrowUpRight className="w-3 h-3" /></Link>}
        />
        {replaced ? (
          <>
            <div className={cn("leading-snug text-sol-text-muted", compact ? "text-[12.5px]" : "text-[14px] font-medium")} data-trace-replaced={replaced.by}>{replacedWords(replaced)}</div>
            {replaced.why && <p className="mt-0.5 leading-snug text-sol-text-dim" data-trace-replaced-why>{replaced.why}.</p>}
          </>
        ) : run && <div className={cn("leading-snug", compact ? "text-[12.5px]" : "text-[14px] font-medium")}><RunOutcomeText run={run} muted={superseded} brief={compact} /></div>}
        {(many || sameAs != null) && (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-sol-text-dim" data-trace-run-repeat={many ? rounds!.join(",") : `same-as-${sameAs}`}>
            <span>{replaced
              ? many ? "Each reached a card and was replaced before anyone answered." : `Like run ${sameAs}, it reached a card and was replaced before anyone answered.`
              : many ? "Each ended the same way, through the same steps." : `The same steps and end as run ${sameAs}.`}</span>
            {sameAs != null && (
              <button type="button" onClick={() => setShowSteps((o) => !o)} className="inline-flex items-center gap-1 hover:text-sol-text-muted" aria-expanded={showSteps} data-trace-run-steps>
                <ChevronRight className={cn("w-3 h-3 transition-transform", showSteps && "rotate-90")} />{showSteps ? "Hide its steps" : "Show its steps"}
              </button>
            )}
          </div>
        )}
        {b.rounds > 1 && (
          <div className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-sol-yellow" data-trace-loops>
            <RotateCcw className="w-3 h-3" />
            {b.rounds} rounds through build
          </div>
        )}
        {showSteps && <ul className={cn("mt-1.5 rounded-md border border-sol-border/25 bg-sol-bg-alt/20", compact ? "px-2 py-1 space-y-0.5" : "px-2.5 py-1.5 space-y-1")} data-trace-stations>
          {rows.map((r, i) => <RunRow key={r.kind === "station" ? r.step.id : `loop-${i}`} row={r} ctx={ctx} card={r.kind === "station" && r.step.nodeId === CARD_GATE_NODE_ID ? b.card : undefined} />)}
          {b.card && !rows.some((r) => r.kind === "station" && r.step.nodeId === CARD_GATE_NODE_ID) && <CardRow card={b.card} compact={compact} />}
          {routine > 0 && (
            <li>
              <button type="button" onClick={() => setShowRoutine((o) => !o)} className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted" aria-expanded={showRoutine} data-trace-routine={routine}>
                <ChevronRight className={cn("w-3 h-3 transition-transform", showRoutine && "rotate-90")} />
                {showRoutine ? "Hide the card's routine steps" : `${routine} routine ${routine === 1 ? "step" : "steps"} assembling the card`}
              </button>
            </li>
          )}
        </ul>}
      </div>
    </li>
  );
}

const ROW_TONE: Record<TraceStatus, string> = { done: "text-sol-text", failed: "text-sol-red", current: "text-sol-blue", waiting: "text-sol-yellow", skipped: "text-sol-text-dim", noted: "text-sol-text-muted" };

/** A replaced run's card, as one row of its run: the card's title and where to open it. */
function CardRow({ card, compact }: { card: NonNullable<RunBlockData["card"]>; compact: boolean }) {
  return (
    <li className="flex items-baseline gap-2 min-w-0 text-[12px]" data-trace-run-card>
      <StepMark state="noted" className="self-center" />
      <span className={cn("shrink-0 text-sol-text-dim", compact ? "w-16 text-[11px]" : "w-20 text-[11.5px]")}>Card</span>
      <CardWords card={card} />
    </li>
  );
}

function CardWords({ card }: { card: NonNullable<RunBlockData["card"]> }) {
  return (
    <>
      <span className="min-w-0 truncate text-sol-text-muted" title={card.title} data-trace-run-card-title>{card.title}</span>
      {card.href && <Link href={card.href} className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[11px] text-sol-text-dim hover:text-sol-blue" data-trace-run-card-open>Open the card<ArrowUpRight className="w-3 h-3" /></Link>}
    </>
  );
}

/** A station row's mark: RunReport's, except that a step ended without a
 *  verdict reads as asked only at a gate (the hand, a person was asked); one
 *  cut off elsewhere was stopped, and takes the stop mark. */
function RowMark({ step: s }: { step: TraceStep }) {
  if (s.status === "noted" && !isGateNode(s.nodeId)) return <CircleStop className="w-3.5 h-3.5 shrink-0 self-center text-sol-text-dim" aria-label="Stopped before it finished" />;
  return <StepMark state={STEP_STATE[s.status]} className="self-center" />;
}

function RunRow({ row, ctx, card }: { row: TraceRunRow; ctx: Ctx; card?: RunBlockData["card"] }) {
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
      <RowMark step={s} />
      <span className={cn("shrink-0 truncate text-sol-text-dim", compact ? "w-16 text-[11px]" : "w-20 text-[11.5px]")} title={s.title}>{s.title}</span>
      {card ? <CardWords card={card} /> : <span className={cn("min-w-0", compact ? "truncate" : "", ROW_TONE[s.status])} data-trace-result>{s.detail}</span>}
      {row.visit > 1 && <span className="shrink-0 rounded px-1 text-[10.5px] text-sol-yellow border border-sol-yellow/30" title="This station ran again in this run" data-trace-visit-chip>visit {row.visit}</span>}
      {!card && <span className="ml-auto shrink-0 flex items-baseline gap-2">
        {!compact && s.durationMs != null && s.durationMs > 0 && <span className="text-[11px] text-sol-text-dim tabular-nums">{took(s.durationMs)}</span>}
        {session?.href && (
          <Link href={session.href} className="inline-flex items-center gap-0.5 text-[11px] text-sol-text-dim hover:text-sol-blue" title={session.label} data-trace-session>
            {session.kind === "decision" ? "card" : "session"}<ArrowUpRight className="w-3 h-3" />
          </Link>
        )}
      </span>}
    </li>
  );
}
