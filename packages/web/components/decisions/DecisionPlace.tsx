"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, List } from "lucide-react";

const STEP = "py-0.5 hover:text-sol-text hover:bg-sol-card transition-colors";

// Where the sheet's ask sits, in its header. Walking the queue, the count
// opens the whole list and the arrows step it; among a thread's own asks the
// arrows step those without answering this one; with no way to step it is
// only the count.
export function DecisionPlace({ position, total, queue, onPrev, onNext }: {
  position: number;
  total: number;
  /** The queue is being walked: the count links to every decision waiting. */
  queue?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const count = (
    <>
      <span className="decision-head-wide">{queue ? "" : "decision "}{position} of {total}</span>
      <span className="decision-head-short">{position}/{total}</span>
    </>
  );
  if (!queue && !onPrev && !onNext) return <span className="shrink-0 text-meta text-sol-text-dim tabular-nums" data-decision-place>{count}</span>;
  const where = queue ? "" : " in this thread";
  return (
    <span className="shrink-0 flex items-center rounded-full border border-sol-border text-meta text-sol-text-muted tabular-nums" data-decision-place>
      {onPrev && (
        <button onClick={onPrev} className={`pl-1.5 pr-0.5 rounded-l-full ${STEP}`} title={`Previous decision${where}`} aria-label={`Previous decision${where}`}>
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}
      {queue ? (
        <Link href="/decisions" className={`flex items-center gap-1 px-1.5 no-underline ${STEP}`} title="All decisions waiting on you">
          <List className="w-3 h-3" />
          {count}
        </Link>
      ) : <span className="px-1.5 py-0.5">{count}</span>}
      {onNext && (
        <button onClick={onNext} className={`pl-0.5 pr-1.5 rounded-r-full ${STEP}`} title={`Next decision${where}`} aria-label={`Next decision${where}`}>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}
    </span>
  );
}
