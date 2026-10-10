"use client";
// /line/trace/<ref> (docs/architecture/line-map.md LX4): one thing followed
// through the line. Any ref the line knows (a signal, a fingerprint, a cause
// task, a run, a card) opens its cause's story: on the map, the path it took
// with everything else dimmed, loops drawn twice; beside it, the story step
// by step. Hovering a step lights the node it happened at. Paints from the
// store (useLineTrace); the words are lib/line/lineTrace's.
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUpRight, ChevronRight, CircleStop, Play, RotateCcw } from "lucide-react";
import { lineTabHref } from "../../../lib/lineSettings";
import { runHref } from "../../../lib/decisionLinks";
import { cn } from "../../../lib/utils";
import { useTitlebarHead } from "../../../hooks/useTitlebarHead";
import { scopeLine, type LineProject } from "../../../lib/lineFlow";
import { buildLineMap, LINE_MAP_WINDOWS, type LineGraph, type LineMapWindow } from "../../../lib/line/lineMap";
import { tracePathChips, tracePathSummary, type LineTrace, type TraceRows, type TraceTone } from "../../../lib/line/lineTrace";
import { EdgeArrows } from "../EdgeArrows";
import { edgeAttrs, useScrollEdges } from "../useScrollEdges";
import { outcomeToneClass } from "../RunReport";
import { LineMap } from "../map/LineMap";
import { layoutLineMap } from "../../../lib/line/lineMapLayout";
import { traceRefOf } from "../../../lib/line/lineMapUrl";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { DOT, TraceStory } from "./TraceStory";
import { DoubtChip } from "../DoubtChip";
import { AskAgain } from "../AskAgain";
import { useLineTrace } from "./useLineTrace";
import { useLineCauseActions } from "../map/useLineCause";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import "./trace.css";
import { graphKeyOf, type GraphRun } from "../../../lib/line/lineGraphs";

/** A card's headline in a few words, lower case, for the answer button ("intro emails say what each person wants"). */
const fewWords = (s: string) => {
  const words = s.trim().split(/\s+/);
  const head = words.slice(0, 7).join(" ").replace(/[,;:.]$/, "");
  return `${head[0]?.toLowerCase() ?? ""}${head.slice(1)}${words.length > 7 ? "…" : ""}`;
};

const VIA: Record<LineTrace["via"], string> = { cause: "", signal: "Traced from the finding", fingerprint: "Traced from a matching report", run: "Traced from the run", decision: "Traced from the decision" };

export function LineTracePage({ refParam }: { refParam: string }) {
  const ref = traceRefOf(refParam ?? "");
  const { trace, rows, ready, graph, graphKey, project, now } = useLineTrace(ref);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  // The whole map is one click away; the path strip is what reads at a glance.
  const [full, setFull] = useState(false);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const projectId = (trace?.cause as { project_id?: string } | undefined)?.project_id ?? null;
  const lineHref = projectId ? lineTabHref(projectId) : "/line";

  return (
    <div className="h-full flex flex-col min-h-0" data-line-trace-page={ref}>
      <div ref={titlebarRef} className="shrink-0 border-b border-sol-border/30 px-5 py-2.5 flex items-center gap-1.5 text-[12px] text-sol-text-dim min-w-0">
        <Link href={lineHref} className="hover:text-sol-text" data-trace-crumb>{project?.title ?? (projectId ? "This project" : "The line")}</Link>
        <ChevronRight className="w-3 h-3 shrink-0" />
        <span className="text-sol-text-muted">Trace</span>
        {/* The cause by its short ref, whatever ref opened the page (a run's raw id, a fingerprint). */}
        <span className="ml-1 min-w-0 truncate font-mono text-[11px] text-sol-text-dim" title={trace?.cause.title ?? ref}>{trace?.cause.short_id || ref}</span>
      </div>

      <div className="ltrace-body flex-1 min-h-0 overflow-y-auto">
        {!trace ? (
          <div className="max-w-[40rem] mx-auto px-5 py-16" data-trace-missing={ready ? "" : undefined}>
            {ready ? (
              <>
                <h1 className="text-[17px] font-medium text-sol-text">Nothing on the line matches {ref || "that ref"}</h1>
                <p className="mt-2 text-[13px] leading-relaxed text-sol-text-muted">
                  A trace starts from a signal (sg-N), a problem (ct-N), a run or a decision (sd-N). It reads what this workspace holds: the last two weeks of signals and the newest runs.
                </p>
                <Link href="/line" className="mt-4 inline-block text-[13px] text-sol-blue hover:underline">Open the line</Link>
              </>
            ) : (
              <p className="text-[13px] text-sol-text-dim">Finding {ref} on the line</p>
            )}
          </div>
        ) : (
          <div className="ltrace-grid" data-full-map={full ? "true" : undefined}>
            <div className="min-w-0">
              <TraceHead trace={trace} />
              <PathStrip trace={trace} focusNode={focusNode} onFocusNode={setFocusNode} full={full} onFull={() => setFull((f) => !f)} />
              <div className="mt-6">
                <TraceStory trace={trace} rows={rows} onFocusNode={setFocusNode} />
              </div>
            </div>
            {full && (
              <div className="ltrace-map-col">
                <div className="ltrace-map rounded-xl border border-sol-border/30 overflow-hidden flex flex-col" data-trace-map>
                  <TraceMap trace={trace} rows={rows} graph={graph} graphKey={graphKey} project={project} now={now} focusNode={focusNode} traceRef={ref} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The cause's title, where it is now in one sentence, and the one thing
 *  to do about it while a card waits: answer it, right here. */
export function TraceHead({ trace, compact = false }: { trace: LineTrace; compact?: boolean }) {
  const c = trace.cause;
  const via = VIA[trace.via];
  // A card open on the cause waits on a person, whatever a later run is doing.
  const card = trace.steps.find((s) => s.stage === "card" && s.status === "current");
  const cardHref = card?.links[0]?.href;
  const cardRef = cardHref?.split("/").pop();
  // When the card is where the cause is, the button says it; the sentence would repeat it.
  const buttonSays = !!card && trace.hereNodeId === CARD_GATE_NODE_ID && trace.where.tone === "waiting";
  const about = card?.headline ? fewWords(card.headline) : null;
  const router = useRouter();
  const answer = () => {
    const step = card && document.querySelector<HTMLElement>(`[data-trace-step-id="${CSS.escape(card.id)}"]`);
    if (step) {
      step.scrollIntoView({ block: "center" });
      step.dataset.traceFlash = "true";
      setTimeout(() => { delete step.dataset.traceFlash; }, 1400);
    } else if (cardHref) router.push(cardHref);
  };
  return (
    <header data-trace-head>
      <h1 className={cn("leading-snug text-sol-text", compact ? "text-[14px] font-medium" : "text-[20px] font-semibold")}>{c.title}</h1>
      {trace.doubt && <DoubtChip doubt={trace.doubt} className="mt-2" />}
      {!compact && <p className="mt-1 text-[12.5px] text-sol-text-muted" data-trace-summary>{tracePathSummary(trace)}{via && <span data-trace-via={trace.via}>. {via}.</span>}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {!buttonSays && (
          // A stall is the one place to act, said in the warning ink at body size, never as an error banner.
          // Stalled, the sentence takes its own line and its two ways out sit under it as one row.
          <p className={cn("font-normal leading-snug", trace.stalledRun && "basis-full", compact ? "text-[12.5px]" : "text-[15px]", trace.where.tone === "stuck" ? "text-sol-yellow" : outcomeToneClass(trace.where.tone))} data-trace-where>
            {trace.where.text}
            {trace.whereRun && !trace.stalledRun && (
              <Link href={runHref(trace.whereRun.runId)} className="ml-2 inline-flex items-center gap-0.5 text-[12px] font-normal text-sol-text-dim hover:text-sol-blue" data-trace-where-run>
                Open run {trace.whereRun.round}<ArrowUpRight className="w-3 h-3" />
              </Link>
            )}
          </p>
        )}
        {trace.stalledRun && (
          <div className="flex flex-wrap items-center gap-2" data-trace-stall-actions>
            <RetryStalled trace={trace} run={trace.stalledRun} />
            <Link href={runHref(trace.stalledRun.runId)} className="ltrace-action" data-trace-where-run>
              Open run {trace.stalledRun.round}<ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        )}
        {trace.askAgain && <AskAgain taskId={trace.cause._id} projectId={(trace.cause as { project_id?: string }).project_id ?? null} />}
        {card && (cardHref || !compact) && (
          <button type="button" onClick={answer} className="ltrace-answer min-w-0" data-trace-answer={cardRef} title={card.headline ?? undefined}>
            <span className="min-w-0 truncate">Answer decision{cardRef ? ` ${cardRef}` : ""}{about ? `: ${about}` : ""}</span><ArrowDown className="w-3 h-3 shrink-0" />
          </button>
        )}
      </div>
    </header>
  );
}

/** The way out of a stall (lineTrace stalledRun): nothing drives the run
 *  answered Ship. A run that stands at a node is resumed there on its machine
 *  (store resumeLineRun), so the answer already given carries it to ship. One
 *  that cannot be resumed is started over through the same start "Start now"
 *  uses (dispatch startLineCause), which ends it and brings a new card. */
function RetryStalled({ trace, run }: { trace: LineTrace; run: NonNullable<LineTrace["stalledRun"]> }) {
  const projectId = (trace.cause as { project_id?: string }).project_id ?? null;
  const { start, error: startError } = useLineCauseActions(projectId);
  const [sent, setSent] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const error = run.resumable ? resumeError : startError;
  const failed = sent && !!error;
  const resume = () => {
    setResumeError(null);
    useInboxStore.getState().resumeLineRun(run.runId).catch((e: unknown) => {
      setResumeError((e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it");
    });
  };
  const label = run.resumable
    ? (sent && !error ? `Resuming run ${run.round}` : `Resume run ${run.round}`)
    : (sent && !error ? `Starting run ${trace.runs.length + 1}` : `Retry run ${run.round}`);
  return (
    <span className="inline-flex items-center gap-2 min-w-0" data-trace-retry={run.runId} data-trace-resumable={run.resumable || undefined}>
      <button
        type="button"
        className="ltrace-answer"
        disabled={sent && !error}
        onClick={() => { setSent(true); if (run.resumable) resume(); else start(trace.cause._id); }}
        title={run.resumable
          ? `Continues run ${run.round} where it stopped, on the machine that ran it. Your answer stands: it goes on to ship.`
          : `Ends run ${run.round}, which nothing is driving, and starts the line on this problem again. The new run rebuilds the change and brings you a new decision.`}
      >
        {run.resumable ? <Play className="w-3 h-3 shrink-0" /> : <RotateCcw className="w-3 h-3 shrink-0" />}{label}
      </button>
      {failed && <span className="text-[12px] text-sol-red" role="alert">{error}</span>}
    </span>
  );
}

/** The trace's path as one strip of chips at reading size (LX4): only the
 *  nodes this item went through, in order, each chip in its step's status
 *  color (the story's dots use the same) and taking you to that step. The
 *  whole line is behind "Full size". */
function PathStrip({ trace, focusNode, onFocusNode, full, onFull }: { trace: LineTrace; focusNode: string | null; onFocusNode: (id: string | null) => void; full: boolean; onFull: () => void }) {
  const chips = useMemo(() => tracePathChips(trace), [trace]);
  // The run tally above already says how many runs there were, so a chip
  // counts its visits only where they differ from the runs that reached it
  // (a loop inside one run).
  const row = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(row, chips.length);
  // Where the item is now: the last chip under way, ringed and scrolled into
  // the strip's view on arrival so it never hides past the edge.
  // One value says where it is (lineTrace hereNodeId), the same the header reads.
  const current = trace.hereNodeId && chips.some((c) => c.nodeId === trace.hereNodeId) ? trace.hereNodeId : null;
  // After commit, when the chips have their widths; block "nearest" keeps the page where it is.
  useWatchEffect(() => {
    const el = row.current;
    const chip = current ? el?.querySelector<HTMLElement>(`[data-trace-chip="${CSS.escape(current)}"]`) : null;
    if (!el || !chip) return;
    // The strip opens on a chip's start, the first one from which the current
    // chip shows whole, so the left edge never cuts a name in half (scrolled
    // to the very end, a snap could not place it).
    const left0 = el.getBoundingClientRect().left - el.scrollLeft;
    // The chip after it shows whole too, so the step coming next never sits under the arrow.
    const next = (chip.parentElement?.nextElementSibling?.querySelector<HTMLElement>("[data-trace-chip]")) ?? null;
    const end = Math.max(chip.getBoundingClientRect().right, next && next.getBoundingClientRect().right - chip.getBoundingClientRect().left <= el.clientWidth ? next.getBoundingClientRect().right : 0) - left0;
    const starts = [...el.querySelectorAll<HTMLElement>("[data-trace-chip]")].map((c) => c.getBoundingClientRect().left - left0);
    const at = starts.find((x) => x + el.clientWidth >= end) ?? 0;
    el.scrollTo({ left: Math.max(0, Math.round(at)), behavior: "auto" });
  }, [current, chips.length]);
  const go = (id: string) => {
    const step = document.querySelector<HTMLElement>(`[data-trace-node="${CSS.escape(id)}"], [data-trace-station="${CSS.escape(id)}"]`);
    step?.scrollIntoView({ block: "center", behavior: "smooth" });
    onFocusNode(id);
  };
  return (
    <div className="mt-4" data-trace-strip>
      <div className="flex items-baseline gap-3 mb-1.5 text-[11px] text-sol-text-dim">
        <span>Its path on the line</span>
        <button type="button" onClick={onFull} className="ml-auto hover:text-sol-text" data-trace-map-zoom={full ? "full" : "strip"} aria-pressed={full}>
          {full ? "Hide the full map" : "Full size"}
        </button>
      </div>
      <div className="relative ltrace-strip-frame">
        <div ref={row} className="ltrace-strip line-edge-fade line-scroll-quiet" {...edgeAttrs(edges)}>
          {chips.map((c, i) => (
            <span key={`${c.nodeId}:${i}`} className="contents">
              {i > 0 && <ChevronRight className="w-3 h-3 shrink-0 text-sol-text-dim/70" aria-hidden />}
              <button
                type="button"
                className="ltrace-chip"
                data-status={c.tone}
                data-focus={focusNode === c.nodeId ? "true" : undefined}
                data-current={current === c.nodeId ? "true" : undefined}
                data-trace-chip={c.nodeId}
                onClick={() => go(c.nodeId)}
                onMouseEnter={() => onFocusNode(c.nodeId)}
                onMouseLeave={() => onFocusNode(null)}
                data-stops={c.stops || undefined}
                title={`${c.label}: ${CHIP_WORDS[c.tone]}${c.times > 1 ? `, ${c.times} visits in ${c.runs} ${c.runs === 1 ? "run" : "runs"}` : ""}${c.stops ? `. ${c.stops === 1 ? "1 run" : `${c.stops} runs`} stopped here` : ""}. Go to it in the story`}
              >
                <span className={cn("w-2 h-2 rounded-full border-[1.5px] shrink-0", DOT[c.tone])} aria-hidden />
                <span>{c.label}</span>
                {c.times > 1 && c.times !== c.runs && <span className="text-sol-text-dim tabular-nums" data-trace-chip-times={c.times}>x{c.times}</span>}
                {c.stops > 0 && <span className="inline-flex items-center gap-0.5 text-[11px] text-sol-red tabular-nums" data-trace-chip-stops={c.stops}><CircleStop className="w-3 h-3" aria-hidden />{c.stops}</span>}
              </button>
            </span>
          ))}
        </div>
        <EdgeArrows scroller={row} edges={edges} label="the path" />
      </div>
    </div>
  );
}

const CHIP_WORDS: Record<TraceTone, string> = { replaced: "passed on its last visit, and that run's decision was replaced by a newer run", done: "passed on its last visit", failed: "stopped here on its last visit", current: "under way", waiting: "not reached yet", skipped: "skipped", noted: "ended without a verdict on its last visit" };

/** The smallest window that holds the whole trace, so every hop on its path counts on the map. */
function windowFor(trace: LineTrace, now: number): LineMapWindow {
  const first = Math.min(...trace.steps.map((s) => s.at ?? Infinity), trace.cause.created_at ?? Infinity);
  const age = Number.isFinite(first) ? now - first : 0;
  return (Object.keys(LINE_MAP_WINDOWS) as LineMapWindow[]).find((w) => LINE_MAP_WINDOWS[w] >= age) ?? "30d";
}

/** The cause's project's line with the trace's path lit and the rest dimmed
 *  (LX4). Hovering a step in the story focuses the node it happened at; a
 *  click opens that node on the project's map, still tracing. */
function TraceMap({ trace, rows, graph, graphKey, project, now, focusNode, traceRef }: { trace: LineTrace; rows: TraceRows; graph: LineGraph | null; graphKey: string; project: LineProject | null; now: number; focusNode: string | null; traceRef: string }) {
  const router = useRouter();
  const projectId = (trace.cause as { project_id?: string }).project_id ?? null;
  const lp = project?.line_profile ?? null;
  const win = windowFor(trace, now);
  const map = useMemo(() => {
    const scoped = projectId ? scopeLine(rows, projectId) : rows;
    // Only the runs of the graph on show, so its counts are its own.
    const runs = scoped.runs.filter((r) => graphKeyOf(r as GraphRun) === graphKey);
    return buildLineMap({ graph, finders: lp?.finders, findersSince: lp?.changed_at, signals: scoped.signals, tasks: scoped.tasks, runs, decisions: rows.decisions, now, windowMs: LINE_MAP_WINDOWS[win] });
  }, [rows, projectId, graph, graphKey, lp, now, win]);
  const layout = useMemo(() => layoutLineMap(map), [map]);
  const open = (node: string) => {
    if (!projectId) return;
    const q = new URLSearchParams({ tab: "line", node, trace: traceRef, graph: graphKey, ...(win !== "7d" ? { window: win } : {}) });
    router.push(`/projects/${project?.short_id || projectId}?${q}`);
  };
  return (
    <>
      <div className="shrink-0 flex items-baseline gap-3 px-3 pt-2 pb-1 text-[11px] text-sol-text-dim">
        <span>Its path on {projectId ? "this project's line" : "the line"}</span>
        <span className="ml-auto">counts over the last {win}</span>
      </div>
      <div className="ltrace-map-box">
        <LineMap className="lmap-fit" map={map} layout={layout} highlightPath={trace.pathNodeIds} focusedNode={focusNode} onSelectNode={projectId ? open : undefined} />
      </div>
    </>
  );
}
