"use client";
// Where the problems no answer can reach live (line-journeys.md LJ8.1, LJ8.5):
// one quiet line per Problems chip, each opening that chip. The counts are the
// Problems list's own (every process, no chip or search), so the chip opened
// shows the same number. For you lists them under its list; Line names the
// idle ones above its steps.
import { useMemo } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { STATUS_LABELS, type StatusKey } from "../../../../lib/line/problemStatus";
import { useProblemList } from "./timeline/useProblemList";
import type { LineViewProps } from "./types";
import "./pointers.css";

/** The Problems list over every process with no chip or search: its rows (each problem's one status) and its count per chip. */
/** `process`: one line's list instead (the Line page's own line, or For you narrowed to it); its pointers then open that line's chip. */
export function useAllProblems({ model, workspace, selection, process = null }: Pick<LineViewProps, "model" | "workspace" | "selection"> & { process?: string | null }) {
  const unfiltered = useMemo(() => ({ ...selection, status: null, process, q: null, sort: null }), [selection, process]);
  return useProblemList(model, workspace, unfiltered);
}

/** The Problems list's count per chip, over every process (or `process`) with no chip or search. */
export const useProblemCounts = (p: Pick<LineViewProps, "model" | "workspace" | "selection"> & { process?: string | null }): Record<StatusKey, number> => useAllProblems(p).counts.by;

/** The pointers for `keys` that hold something, in that order. */
export function ProblemPointers({ keys, counts, href, className, label, process = null }: Pick<LineViewProps, "href"> & { keys: ReadonlyArray<StatusKey>; counts: Record<StatusKey, number>; className?: string; label: string; process?: string | null }) {
  const shown = keys.filter((k) => counts[k] > 0);
  if (!shown.length) return null;
  return (
    <nav className={className} aria-label={label}>
      {shown.map((k) => (
        <Link key={k} className="lw-pointer" href={href({ view: "problems", status: k, process, need: null, decision: null, card: null })} data-line-pointer={k}>
          <span>{STATUS_LABELS[k]}</span><span className="lw-num">{counts[k]}</span><ChevronRight className="lw-pointer-go" aria-hidden />
        </Link>
      ))}
    </nav>
  );
}
