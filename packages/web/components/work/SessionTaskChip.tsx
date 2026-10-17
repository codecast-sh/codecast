"use client";

// The task a session owns (convex lib/taskOwner.ts), on the session's inbox
// card: the task's status in its own colour, its title, as plain meta
// text beside the project. It is part of the card, so a click on it opens
// the session like any other part of the card. The status reads from the
// task's live row when the store holds it, so a status moved anywhere shows
// here at once.

import { taskVisual } from "../TaskStatusBadge";
import { useInboxStore } from "../../store/inboxStore";

export function SessionTaskChip({ task, className = "" }: {
  task: { _id: string; short_id?: string | null; title: string; status?: string | null };
  className?: string;
}) {
  const status = useInboxStore((s) => (s.tasks as any)[task._id]?.status ?? task.status ?? null);
  const { icon: StatusIcon, color, label } = taskVisual(status);
  return (
    <span
      data-session-task
      title={`${task.short_id ?? "Task"}: ${task.title} (${label.toLowerCase()})`}
      className={`inline-flex items-center gap-1 min-w-0 max-w-[16rem] text-[10px] text-sol-text-muted ${className}`}
    >
      <StatusIcon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
      <span className="truncate">{task.title}</span>
    </span>
  );
}
