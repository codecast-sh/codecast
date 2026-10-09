"use client";
// The one doubt the record raised about a cause (lineTrace causeDoubt), as a
// caution chip a reviewer cannot miss: on a trace's header and on the card
// that asks to ship its fix. The note that raised it opens under it.
import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import type { CauseDoubt } from "../../lib/line/lineTrace";

export function DoubtChip({ doubt, className }: { doubt: CauseDoubt; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("flex flex-col items-start gap-1.5", className)} data-cause-doubt>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-sol-yellow/45 bg-sol-yellow/10 px-2 py-0.5 text-[12px] text-sol-yellow hover:bg-sol-yellow/15 transition-colors"
      >
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        {doubt.words}
        <ChevronRight className={cn("w-3 h-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && <p className="max-w-[46rem] border-l-2 border-sol-yellow/40 pl-2.5 text-[12.5px] leading-relaxed text-sol-text-muted" data-cause-doubt-why>{doubt.why}</p>}
    </div>
  );
}
