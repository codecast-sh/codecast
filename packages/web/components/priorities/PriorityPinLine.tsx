// The line Codecast adds under a session's pinned state once its priorities
// pass has mapped the session: which of the person's priorities it serves,
// how far that priority's critical path is, and this session's step. It opens
// that priority on /priorities. Written by Codecast, never by the agent; fed
// by hooks/usePriorityPinLine.
import Link from "next/link";
import type { PriorityPinLine } from "@codecast/shared/contracts/priorities";
import { priorityHref } from "../../lib/priorities";

export function PriorityPinLineView({ line }: { line: PriorityPinLine | null }) {
  if (!line) return null;
  return (
    <div data-priority-pin-line className="flex min-w-0 items-center gap-1.5 border-t border-sol-border/40 px-3 py-1 text-meta text-sol-text-muted">
      <span aria-hidden className="shrink-0 text-sol-text-dim">↳</span>
      <Link href={priorityHref(line.short_id)} className="min-w-0 truncate hover:text-sol-text" title={line.title}>
        {line.rank != null && <span className="text-sol-text-dim">#{line.rank} </span>}
        <span className="font-medium text-sol-text">{line.title}</span>
        <span className="text-sol-text-dim"> · </span>
        <span className="tabular-nums" title={`${line.critical_done} of ${line.critical_total} critical-path steps done`}>{line.critical_done}/{line.critical_total}</span>
        {line.step_title && (
          <>
            <span className="text-sol-text-dim"> · </span>
            {line.step_title}
          </>
        )}
      </Link>
    </div>
  );
}
