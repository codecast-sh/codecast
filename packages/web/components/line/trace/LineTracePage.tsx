"use client";
// /line/trace/<ref> (docs/architecture/line-map.md LX4): one thing followed
// through the line. Any ref the line knows (a signal, a fingerprint, a cause
// task, a run, a card) opens its cause's story: on the map, the path it took
// with everything else dimmed, loops drawn twice; beside it, the story step
// by step. Hovering a step lights the node it happened at. Paints from the
// store (useLineTrace); the words are lib/line/lineTrace's.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { lineTabHref } from "../../../lib/lineSettings";
import { cn } from "../../../lib/utils";
import { useTitlebarHead } from "../../../hooks/useTitlebarHead";
import type { LineTrace } from "../../../lib/line/lineTrace";
import { outcomeToneClass } from "../RunReport";
import { TraceStory } from "./TraceStory";
import { useLineTrace } from "./useLineTrace";

const VIA: Record<LineTrace["via"], string> = { cause: "", signal: "Traced from the signal", fingerprint: "Traced from the fingerprint", run: "Traced from the run", decision: "Traced from the card" };

export function LineTracePage({ refParam, map }: { refParam: string; map?: (props: { trace: LineTrace; focusNode: string | null }) => ReactNode }) {
  const ref = decodeURIComponent(refParam ?? "").trim();
  const { trace, rows, ready } = useLineTrace(ref);
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

      <div className="flex-1 min-h-0 overflow-y-auto">
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
          <div className={cn("mx-auto px-5 py-6", map ? "max-w-[96rem] grid gap-8 xl:grid-cols-[minmax(30rem,44rem)_1fr]" : "max-w-[46rem]")}>
            <div className="min-w-0">
              <TraceHead trace={trace} />
              <div className="mt-6">
                <TraceStory trace={trace} rows={rows} onFocusNode={map ? setFocusNode : undefined} />
              </div>
            </div>
            {map && (
              <div className="min-w-0 order-first xl:order-none">
                <div className="xl:sticky xl:top-0 rounded-xl border border-sol-border/30 overflow-hidden h-[360px] xl:h-[calc(100vh-10rem)]" data-trace-map>
                  {map({ trace, focusNode })}
                </div>
              </div>
            )}
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
