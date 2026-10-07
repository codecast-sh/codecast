"use client";
// /line/trace/<ref> (docs/architecture/line-map.md LX4): one thing followed
// through the line. Any ref the line knows (a signal, a fingerprint, a cause
// task, a run, a card) opens its cause's story: on the map, the path it took
// with everything else dimmed, loops drawn twice; beside it, the story step
// by step. Hovering a step lights the node it happened at. Paints from the
// store (useLineTrace); the words are lib/line/lineTrace's.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { lineTabHref } from "../../../lib/lineSettings";
import { cn } from "../../../lib/utils";
import { useTitlebarHead } from "../../../hooks/useTitlebarHead";
import { scopeLine, type LineProject } from "../../../lib/lineFlow";
import { buildLineMap, LINE_MAP_WINDOWS, type LineGraph, type LineMapWindow } from "../../../lib/line/lineMap";
import type { LineTrace, TraceRows } from "../../../lib/line/lineTrace";
import { outcomeToneClass } from "../RunReport";
import { LineMap } from "../map/LineMap";
import { TraceStory } from "./TraceStory";
import { useLineTrace } from "./useLineTrace";
import "./trace.css";

const VIA: Record<LineTrace["via"], string> = { cause: "", signal: "Traced from the signal", fingerprint: "Traced from the fingerprint", run: "Traced from the run", decision: "Traced from the card" };

export function LineTracePage({ refParam }: { refParam: string }) {
  const ref = decodeURIComponent(refParam ?? "").trim();
  const { trace, rows, ready, graph, project, now } = useLineTrace(ref);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const projectId = (trace?.cause as { project_id?: string } | undefined)?.project_id ?? null;
  const lineHref = projectId ? lineTabHref(projectId) : "/line";

  return (
    <div className="h-full flex flex-col min-h-0" data-line-trace-page={ref}>
      <div ref={titlebarRef} className="shrink-0 border-b border-sol-border/30 px-5 py-2.5 flex items-center gap-1.5 text-[12px] text-sol-text-dim min-w-0">
        <Link href={lineHref} className="hover:text-sol-text">{projectId ? "This project's line" : "The line"}</Link>
        <ChevronRight className="w-3 h-3 shrink-0" />
        <span className="text-sol-text-muted">Trace</span>
        <span className="ml-1 min-w-0 truncate font-mono text-[11px] text-sol-text-dim" title={ref}>{ref}</span>
      </div>

      <div className="ltrace-body flex-1 min-h-0 overflow-y-auto">
        {!trace ? (
          <div className="max-w-[40rem] mx-auto px-5 py-16" data-trace-missing={ready ? "" : undefined}>
            {ready ? (
              <>
                <h1 className="text-[17px] font-medium text-sol-text">Nothing on the line goes by {ref || "that name"}</h1>
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
          <div className="ltrace-grid">
            <div className="min-w-0">
              <TraceHead trace={trace} />
              <div className="mt-6">
                <TraceStory trace={trace} rows={rows} onFocusNode={setFocusNode} />
              </div>
            </div>
            <div className="ltrace-map-col">
              <div className="ltrace-map rounded-xl border border-sol-border/30 overflow-hidden flex flex-col" data-trace-map>
                <TraceMap trace={trace} rows={rows} graph={graph} project={project} now={now} focusNode={focusNode} traceRef={ref} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The cause's title, where it is now in one sentence, and what this trace was opened from. */
export function TraceHead({ trace, compact = false }: { trace: LineTrace; compact?: boolean }) {
  const c = trace.cause;
  const via = VIA[trace.via];
  return (
    <header data-trace-head>
      <h1 className={cn("leading-snug text-sol-text", compact ? "text-[14px] font-medium" : "text-[20px] font-semibold")}>{c.title}</h1>
      <p className={cn("mt-1 font-medium", compact ? "text-[12.5px]" : "text-[14px]", outcomeToneClass(trace.where.tone))} data-trace-where>{trace.where.text}</p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-sol-text-dim">
        <Link href={`/tasks/${c.short_id || c._id}`} className="font-mono text-[11.5px] hover:text-sol-blue hover:underline" title="Open the cause's task">{c.short_id || "the task"}</Link>
        {via && <span data-trace-via={trace.via}>{via}</span>}
        {c.cause && <span>{c.cause.signal_count} {c.cause.signal_count === 1 ? "signal" : "signals"}</span>}
      </div>
    </header>
  );
}

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
  const open = (node: string) => {
    if (!projectId) return;
    const q = new URLSearchParams({ tab: "line", node, trace: traceRef, ...(win !== "7d" ? { window: win } : {}) });
    router.push(`/projects/${project?.short_id || projectId}?${q}`);
  };
  return (
    <>
      <div className="shrink-0 flex items-baseline gap-2 px-3 pt-2 text-[11px] text-sol-text-dim">
        <span>Its path on {projectId ? "this project's line" : "the line"}</span>
        <span className="ml-auto">counts over the last {win}</span>
      </div>
      <LineMap className="lmap-fill" map={map} highlightPath={trace.pathNodeIds} focusedNode={focusNode} onSelectNode={projectId ? open : undefined} />
    </>
  );
}
