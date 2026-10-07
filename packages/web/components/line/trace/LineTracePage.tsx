"use client";
// /line/trace/<ref> (docs/architecture/line-map.md LX4): one thing followed
// through the line. Any ref the line knows (a signal, a fingerprint, a cause
// task, a run, a card) opens its cause's story: on the map, the path it took
// with everything else dimmed, loops drawn twice; beside it, the story step
// by step. Hovering a step lights the node it happened at. Paints from the
// store (useLineTrace); the words are lib/line/lineTrace's.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ChevronRight } from "lucide-react";
import { lineTabHref } from "../../../lib/lineSettings";
import { cn } from "../../../lib/utils";
import { useTitlebarHead } from "../../../hooks/useTitlebarHead";
import { scopeLine, type LineProject } from "../../../lib/lineFlow";
import { buildLineMap, LINE_MAP_WINDOWS, type LineGraph, type LineMapWindow } from "../../../lib/line/lineMap";
import { tracePathChips, tracePathSummary, type LineTrace, type TraceRows } from "../../../lib/line/lineTrace";
import { EdgeArrows } from "../EdgeArrows";
import { edgeAttrs, useScrollEdges } from "../useScrollEdges";
import { outcomeToneClass } from "../RunReport";
import { LineMap } from "../map/LineMap";
import { layoutLineMap } from "../../../lib/line/lineMapLayout";
import { traceRefOf } from "../../../lib/line/lineMapUrl";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { DOT, TraceStory } from "./TraceStory";
import { useLineTrace } from "./useLineTrace";
import "./trace.css";

/** A card's headline in a few words, lower case, for the answer button ("intro emails say what each person wants"). */
const fewWords = (s: string) => {
  const words = s.trim().split(/\s+/);
  const head = words.slice(0, 7).join(" ").replace(/[,;:.]$/, "");
  return `${head[0]?.toLowerCase() ?? ""}${head.slice(1)}${words.length > 7 ? "…" : ""}`;
};

const VIA: Record<LineTrace["via"], string> = { cause: "", signal: "Traced from the signal", fingerprint: "Traced from the fingerprint", run: "Traced from the run", decision: "Traced from the card" };

export function LineTracePage({ refParam }: { refParam: string }) {
  const ref = traceRefOf(refParam ?? "");
  const { trace, rows, ready, graph, project, now } = useLineTrace(ref);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  // The whole map is one click away; the path strip is what reads at a glance.
  const [full, setFull] = useState(false);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const projectId = (trace?.cause as { project_id?: string } | undefined)?.project_id ?? null;
  const lineHref = projectId ? lineTabHref(projectId) : "/line";

  return (
    <div className="h-full flex flex-col min-h-0" data-line-trace-page={ref}>
      <div ref={titlebarRef} className="shrink-0 border-b border-sol-border/30 px-5 py-2.5 flex items-center gap-1.5 text-[12px] text-sol-text-dim min-w-0">
        <Link href={lineHref} className="hover:text-sol-text" data-trace-crumb>{project?.title ? `${project.title} line` : projectId ? "This project's line" : "The line"}</Link>
        <ChevronRight className="w-3 h-3 shrink-0" />
        <span className="text-sol-text-muted">Trace</span>
        <span className="ml-1 min-w-0 truncate font-mono text-[11px] text-sol-text-dim" title={ref}>{ref}</span>
      </div>

      <div className="ltrace-body flex-1 min-h-0 overflow-y-auto">
        {!trace ? (
          <div className="max-w-[40rem] mx-auto px-5 py-16" data-trace-missing={ready ? "" : undefined}>
            {ready ? (
              <>
                <h1 className="text-[17px] font-medium text-sol-text">Nothing on the line matches {ref || "that ref"}</h1>
                <p className="mt-2 text-[13px] leading-relaxed text-sol-text-muted">
                  A trace starts from a signal (sg-N), a fingerprint, a cause task (ct-N), a run or a card (sd-N). It reads what this workspace holds: the last two weeks of signals and the newest runs.
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
                  <TraceMap trace={trace} rows={rows} graph={graph} project={project} now={now} focusNode={focusNode} traceRef={ref} />
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
      {!compact && <p className="mt-1 text-[12.5px] text-sol-text-muted" data-trace-summary>{tracePathSummary(trace)}{via && <span data-trace-via={trace.via}>. {via}.</span>}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {!buttonSays && <p className={cn("font-medium", compact ? "text-[12.5px]" : "text-[14px]", outcomeToneClass(trace.where.tone))} data-trace-where>{trace.where.text}</p>}
        {card && (cardHref || !compact) && (
          <button type="button" onClick={answer} className="ltrace-answer min-w-0" data-trace-answer={cardRef} title={card.headline ?? undefined}>
            <span className="min-w-0 truncate">Answer card{cardRef ? ` ${cardRef}` : ""}{about ? `: ${about}` : ""}</span><ArrowDown className="w-3 h-3 shrink-0" />
          </button>
        )}
      </div>
    </header>
  );
}

/** The trace's path as one strip of chips at reading size (LX4): only the
 *  nodes this item went through, in order, each chip in its step's status
 *  color (the story's dots use the same) and taking you to that step. The
 *  whole line is behind "Full size". */
function PathStrip({ trace, focusNode, onFocusNode, full, onFull }: { trace: LineTrace; focusNode: string | null; onFocusNode: (id: string | null) => void; full: boolean; onFull: () => void }) {
  const chips = useMemo(() => tracePathChips(trace), [trace]);
  const row = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(row, chips.length);
  // Where the item is now: the last chip under way, ringed and scrolled into
  // the strip's view on arrival so it never hides past the edge.
  // One value says where it is (lineTrace hereNodeId), the same the header reads.
  const current = trace.hereNodeId && chips.some((c) => c.nodeId === trace.hereNodeId) ? trace.hereNodeId : null;
  useEffect(() => {
    const el = row.current;
    const chip = current && el?.querySelector<HTMLElement>(`[data-trace-chip="${CSS.escape(current)}"]`);
    if (!el || !chip) return;
    const box = el.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    if (r.left < box.left + 48 || r.right > box.right - 48) el.scrollTo({ left: el.scrollLeft + (r.left + r.width / 2) - (box.left + box.width / 2) });
  }, [current]);
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
      <div className="relative">
        <div ref={row} className="ltrace-strip line-edge-fade line-scroll-quiet" {...edgeAttrs(edges)}>
          {chips.map((c, i) => (
            <span key={`${c.nodeId}:${i}`} className="contents">
              {i > 0 && <ChevronRight className="w-3 h-3 shrink-0 text-sol-text-dim/70" aria-hidden />}
              <button
                type="button"
                className="ltrace-chip"
                data-status={c.status}
                data-focus={focusNode === c.nodeId ? "true" : undefined}
                data-current={current === c.nodeId ? "true" : undefined}
                data-trace-chip={c.nodeId}
                onClick={() => go(c.nodeId)}
                onMouseEnter={() => onFocusNode(c.nodeId)}
                onMouseLeave={() => onFocusNode(null)}
                title={`${c.label}: ${CHIP_WORDS[c.status]}${c.times > 1 ? `, ${c.times} visits` : ""}. Go to it in the story`}
              >
                <span className={cn("w-2 h-2 rounded-full border-[1.5px] shrink-0", DOT[c.status])} aria-hidden />
                <span>{c.label}</span>
                {c.times > 1 && <span className="text-sol-text-dim tabular-nums">x{c.times}</span>}
              </button>
            </span>
          ))}
        </div>
        <EdgeArrows scroller={row} edges={edges} label="the path" />
      </div>
    </div>
  );
}

const CHIP_WORDS: Record<LineTrace["steps"][number]["status"], string> = { done: "passed on its last visit", failed: "stopped here on its last visit", current: "under way", waiting: "not reached yet", skipped: "skipped", noted: "ended without a verdict on its last visit" };

/** The smallest window that holds the whole trace, so every hop on its path counts on the map. */
function windowFor(trace: LineTrace, now: number): LineMapWindow {
  const first = Math.min(...trace.steps.map((s) => s.at ?? Infinity), trace.cause.created_at ?? Infinity);
  const age = Number.isFinite(first) ? now - first : 0;
  return (Object.keys(LINE_MAP_WINDOWS) as LineMapWindow[]).find((w) => LINE_MAP_WINDOWS[w] >= age) ?? "30d";
}

/** The cause's project's line with the trace's path lit and the rest dimmed
 *  (LX4). Hovering a step in the story focuses the node it happened at; a
 *  click opens that node on the project's map, still tracing. */
function TraceMap({ trace, rows, graph, project, now, focusNode, traceRef }: { trace: LineTrace; rows: TraceRows; graph: LineGraph | null; project: LineProject | null; now: number; focusNode: string | null; traceRef: string }) {
  const router = useRouter();
  const projectId = (trace.cause as { project_id?: string }).project_id ?? null;
  const lp = project?.line_profile ?? null;
  const win = windowFor(trace, now);
  const map = useMemo(() => {
    const scoped = projectId ? scopeLine(rows, projectId) : rows;
    return buildLineMap({ graph, finders: lp?.finders, findersSince: lp?.changed_at, signals: scoped.signals, tasks: scoped.tasks, runs: scoped.runs, decisions: rows.decisions, now, windowMs: LINE_MAP_WINDOWS[win] });
  }, [rows, projectId, graph, lp, now, win]);
  const layout = useMemo(() => layoutLineMap(map), [map]);
  const open = (node: string) => {
    if (!projectId) return;
    const q = new URLSearchParams({ tab: "line", node, trace: traceRef, ...(win !== "7d" ? { window: win } : {}) });
    router.push(`/projects/${project?.short_id || projectId}?${q}`);
  };
  return (
    <>
      <div className="shrink-0 flex items-baseline gap-3 px-3 pt-2 pb-1 text-[11px] text-sol-text-dim">
        <span>Its path on {projectId ? "this project's line" : "the line"}</span>
        <span className="ml-auto">counts over the last {win}</span>
      </div>
      <div className="ltrace-map-box">
        <LineMap className="lmap-fill" map={map} layout={layout} highlightPath={trace.pathNodeIds} focusedNode={focusNode} onSelectNode={projectId ? open : undefined} />
      </div>
    </>
  );
}
