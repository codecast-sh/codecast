"use client";

import { useMemo } from "react";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useTrackedStore, type SessionDecisionItem } from "../../store/inboxStore";
import { DecisionCompactCard } from "./DecisionCompactCard";

// Open decisions bound to a task (docs/architecture/decisions-as-documents.md
// D3), as cards under the task's description. Same store rows the queue
// renders, same answer action; the row leaves the moment it is answered.
const sig = (d: SessionDecisionItem) => `${d.status}:${d.task_id ?? ""}:${d.updated_at ?? 0}`;

export function TaskDecisions({ taskId }: { taskId: string }) {
  const where = useMemo(() => (d: SessionDecisionItem) => d.task_id === taskId && d.status === "pending", [taskId]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig, sort: (a, b) => Number(b.blocking) - Number(a.blocking) || a.created_at - b.created_at });
  if (rows.length === 0) return null;
  return (
    <div className="mb-6" data-task-decisions={rows.length}>
      <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">
        Waiting on a decision{rows.length > 1 ? `s · ${rows.length}` : ""}
      </h2>
      <div className="space-y-2">
        {rows.map((d) => <DecisionCompactCard key={d._id} decision={d} showTask={false} />)}
      </div>
    </div>
  );
}

// How many open decisions a task carries: the list row's "decision" chip.
// Subscribes to a count string, not the collection, so a row re-renders
// only when its own number changes.
export function useTaskPendingDecisionCount(taskId: string): number {
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
