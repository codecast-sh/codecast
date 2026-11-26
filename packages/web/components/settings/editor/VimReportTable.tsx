// Every directive of the person's vimrc and what became of it: applied as
// written, translated to the editor's equivalent, or skipped and why. The
// status chips are the filter and carry the counts; the rows virtualize (a
// real vimrc runs to thousands of lines).

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw, Search } from "lucide-react";
import { cn } from "../../../lib/utils";
import { modernChip } from "../../ui/modernLook";
import type { VimConfigReport, VimDirectiveStatus } from "../../../lib/code/vim/types";
import { STATUS_TONE } from "../../../lib/code/vim/reportTone";
import { countRows, EMPTY_FILTER, filterRows, reportRows, toggleStatus, type VimReportFilter } from "./vimReportRows";

const STATUSES: VimDirectiveStatus[] = ["applied", "translated", "skipped"];
const ROW_PX = 24;

export function VimReportTable({
  report,
  source,
  onSource,
  reloading,
  onReload,
  sourceLabel,
}: {
  report: VimConfigReport;
  /** Only this source's rows (its index), or null for all. */
  source: number | null;
  onSource: (index: number | null) => void;
  reloading: boolean;
  onReload: () => void;
  sourceLabel: (index: number) => string;
}) {
  const [statuses, setStatuses] = useState<ReadonlySet<VimDirectiveStatus>>(EMPTY_FILTER.statuses);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => reportRows(report), [report]);
  const filter: VimReportFilter = { statuses, query, source };
  const counts = useMemo(() => countRows(rows, { query, source }), [rows, query, source]);
  const shown = useMemo(() => filterRows(rows, filter), [rows, statuses, query, source]); // eslint-disable-line react-hooks/exhaustive-deps
  const multiSource = report.sources.length > 1;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: shown.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_PX, overscan: 12 });

  const chip = (active: boolean, extra: string) =>
    cn(
      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium tabular-nums transition-colors",
      active ? extra : "border-sol-border bg-sol-bg-alt text-sol-text-muted hover:border-sol-text-muted",
      modernChip({ active }),
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 sm:px-5">
        <button type="button" aria-pressed={statuses.size === 0} className={chip(statuses.size === 0, "border-sol-text-muted bg-sol-bg-highlight/60 text-sol-text")} onClick={() => setStatuses(new Set())}>
          All <span className="opacity-70">{counts.total}</span>
        </button>
        {STATUSES.map((st) => (
          <button key={st} type="button" aria-pressed={statuses.has(st)} className={chip(statuses.has(st), STATUS_TONE[st].chip)} onClick={() => setStatuses((s) => toggleStatus(s, st))}>
            <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_TONE[st].dot)} />
            {st}
            <span className="opacity-70">{counts[st]}</span>
          </button>
        ))}
        {source !== null && (
          <button type="button" className={chip(true, "border-sol-violet/60 bg-sol-violet/10 text-sol-violet")} onClick={() => onSource(null)} title="Show every source">
            <span className="max-w-[16rem] truncate font-mono">{sourceLabel(source)}</span>
            <span aria-hidden>×</span>
          </button>
        )}
        <label className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-sol-border bg-sol-bg-alt px-2 focus-within:border-sol-cyan">
          <Search className="h-3 w-3 text-sol-text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter"
            aria-label="Filter directives"
            className="w-36 bg-transparent font-mono text-xs text-sol-text outline-none placeholder:text-sol-text-dim"
          />
        </label>
        <button
          type="button"
          onClick={onReload}
          disabled={reloading}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-sol-border bg-sol-bg-alt text-sol-text-muted hover:text-sol-text disabled:opacity-60"
          title="Read the vimrc again"
          aria-label="Reload vimrc"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", reloading && "animate-spin")} />
        </button>
      </div>
      <div ref={scrollRef} className="max-h-[360px] min-h-[72px] overflow-auto border-t border-sol-border/40" role="table" aria-label="Vimrc directives" aria-rowcount={shown.length}>
        {shown.length === 0 ? (
          <div className="px-5 py-6 text-center text-xs text-sol-text-dim">{rows.length === 0 ? "No directives" : "No matches"}</div>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const r = shown[item.index];
              return (
                <div
                  key={r.id}
                  role="row"
                  className="absolute left-0 right-0 grid grid-cols-[3.25rem_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-3 px-4 text-xs hover:bg-sol-bg-highlight/30 sm:px-5"
                  style={{ height: ROW_PX, transform: `translateY(${item.start}px)` }}
                >
                  <span role="cell" className="text-right font-mono tabular-nums text-sol-text-dim">
                    {multiSource ? (
                      <button type="button" className="hover:text-sol-text" title={sourceLabel(r.sourceIndex)} onClick={() => onSource(r.sourceIndex)}>
                        {r.line}
                      </button>
                    ) : (
                      r.line
                    )}
                  </span>
                  <span role="cell" className="truncate font-mono text-sol-text" title={r.text}>
                    {r.text}
                  </span>
                  <span role="cell" className="flex min-w-0 items-center gap-1.5 text-sol-text-muted" title={`${r.status}: ${r.detail}`}>
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_TONE[r.status].dot)} />
                    <span className={cn("truncate", r.status === "translated" ? "font-mono" : "")}>{r.detail}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
