"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { decisionAnswerLabel } from "@codecast/shared/contracts";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useTrackedStore, type SessionDecisionItem } from "../../store/inboxStore";
import { decisionHref } from "../../lib/decisionLinks";
import { heldDecisionFor, type LineTask } from "../../lib/taskLine";
import { DecisionCompactCard } from "./DecisionCompactCard";

// Decisions bound to a task (docs/architecture/decisions-as-documents.md D3,
// the-line.md L10): open ones as cards under the task's description, the
// answered and dismissed ones folded under a disclosure with their answer.
// Same store rows the queue renders, same answer action; a card moves from
// the open list to the fold the moment it is answered.
const sig = (d: SessionDecisionItem) => `${d.status}:${d.task_id ?? ""}:${d.station ?? ""}:${d.blocking ? 1 : 0}:${d.updated_at ?? 0}:${d.answer_index ?? ""}:${d.answer_text ?? ""}`;
const byUrgency = (a: SessionDecisionItem, b: SessionDecisionItem) => Number(b.blocking) - Number(a.blocking) || a.created_at - b.created_at;
const newestResolved = (a: SessionDecisionItem, b: SessionDecisionItem) => (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at);

const RESOLVED_WORD: Record<string, string> = { answered: "answered", dismissed: "dismissed", withdrawn: "withdrawn" };

/** L5: the pending blocking decision holding the task at its current
 *  station, from the store's decision rows. */
export function useTaskHold(task: Pick<LineTask, "_id" | "status" | "status_id">): SessionDecisionItem | undefined {
  const where = useMemo(() => (d: SessionDecisionItem) => d.task_id === task._id && d.status === "pending" && d.blocking, [task._id]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig });
  return heldDecisionFor(task, rows);
}

function ResolvedRow({ d }: { d: SessionDecisionItem }) {
  const answer = d.status === "answered" ? decisionAnswerLabel(d, d) : undefined;
  return (
    <li className="flex items-baseline gap-2 min-w-0 text-[12px]" data-resolved-decision={d.short_id ?? d._id}>
      <span className={`shrink-0 text-[10px] px-1.5 py-px rounded border ${d.status === "answered" ? "border-sol-green/30 text-sol-green" : "border-sol-border text-sol-text-dim"}`}>
        {RESOLVED_WORD[d.status] ?? d.status}
      </span>
      <Link href={decisionHref(d)} className="min-w-0 truncate text-sol-text-muted hover:text-sol-blue">
        {d.question}
      </Link>
      {answer && <span className="shrink-0 max-w-[12rem] truncate text-sol-text" title={answer}>{answer}</span>}
      <Link href={decisionHref(d)} className="ml-auto shrink-0 inline-flex items-center gap-0.5 font-mono text-[10px] text-sol-text-dim hover:text-sol-text">
        {d.short_id ?? "open"}<ArrowUpRight className="w-3 h-3" />
      </Link>
    </li>
  );
}

export function TaskDecisions({ taskId }: { taskId: string }) {
  const where = useMemo(() => (d: SessionDecisionItem) => d.task_id === taskId, [taskId]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig });
  const open = useMemo(() => rows.filter((d) => d.status === "pending").sort(byUrgency), [rows]);
  const resolved = useMemo(() => rows.filter((d) => d.status !== "pending").sort(newestResolved), [rows]);
  const [unfolded, setUnfolded] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="mb-6" data-task-decisions={open.length} data-task-decisions-resolved={resolved.length}>
      <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">
        {open.length > 0 ? `Waiting on a decision${open.length > 1 ? `s · ${open.length}` : ""}` : "Decisions"}
      </h2>
      {open.length > 0 && (
        <div className="space-y-2">
          {open.map((d) => <DecisionCompactCard key={d._id} decision={d} showTask={false} />)}
        </div>
      )}
      {resolved.length > 0 && (
        <div className={open.length > 0 ? "mt-2" : ""}>
          <button
            type="button"
            onClick={() => setUnfolded((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text"
            aria-expanded={unfolded}
            data-resolved-toggle
          >
            {unfolded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {resolved.length} {resolved.length === 1 ? "decision" : "decisions"} settled
          </button>
          {unfolded && (
            <ul className="mt-1.5 space-y-1 pl-1 border-l-2 border-sol-border/30">
              {resolved.map((d) => <ResolvedRow key={d._id} d={d} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// How many open decisions a task carries: the list row's "decision" chip.
// Subscribes to a count string, not the collection, so a row re-renders
// only when its own number changes.
function useTaskPendingDecisionCount(taskId: string): number {
  const s = useTrackedStore([
    (st) => {
      let n = 0;
      for (const id in st.sessionDecisions) {
        const d = st.sessionDecisions[id];
        if (d.task_id === taskId && d.status === "pending") n++;
      }
      return n;
    },
  ]);
  let n = 0;
  for (const id in s.sessionDecisions) {
    const d = s.sessionDecisions[id];
    if (d.task_id === taskId && d.status === "pending") n++;
  }
  return n;
}

export function TaskDecisionChip({ taskId, className = "" }: { taskId: string; className?: string }) {
  const n = useTaskPendingDecisionCount(taskId);
  if (n === 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-yellow/40 text-[10px] text-sol-yellow shrink-0 ${className}`}
      title={`${n} open decision${n === 1 ? "" : "s"} on this task`}
      data-task-decision-chip={n}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" />
      decision{n > 1 ? ` ${n}` : ""}
    </span>
  );
}
