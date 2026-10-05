"use client";

// The task a session owns (convex lib/taskOwner.ts), on the session's inbox
// card: the task's status in its own colour, its id and title, as plain meta
// text beside the project. A click opens the task beside the inbox and never
// selects the card. The status reads from the task's live row when the store
// holds it, so a status moved anywhere shows here at once.

import type { MouseEvent } from "react";
import { taskVisual } from "../TaskStatusBadge";
import { openBeside } from "../../lib/stage";
import { taskFacePath } from "../../lib/workUnit";
import { useInboxStore } from "../../store/inboxStore";
import { useRouter } from "next/navigation";

export function SessionTaskChip({ task, className = "" }: {
  task: { _id: string; short_id?: string | null; title: string; status?: string | null };
  className?: string;
}) {
  const router = useRouter();
  const status = useInboxStore((s) => (s.tasks as any)[task._id]?.status ?? task.status ?? null);
  const { icon: StatusIcon, color, label } = taskVisual(status);
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const path = taskFacePath(task);
    if (!openBeside(path)) router.push(path);
  };
  return (
    <button
      type="button"
      data-session-task
      onClick={open}
      onPointerDown={(e) => e.stopPropagation()}
      title={`${task.short_id ?? "Task"}: ${task.title} (${label.toLowerCase()}). Click to open it beside.`}
      className={`inline-flex items-center gap-1 min-w-0 max-w-[16rem] text-[10px] text-sol-text-muted hover:text-sol-text transition-colors ${className}`}
    >
      <StatusIcon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
      {task.short_id && <span className="font-mono text-sol-text-dim flex-shrink-0">{task.short_id}</span>}
      <span className="truncate">{task.title}</span>
    </button>
  );
}
