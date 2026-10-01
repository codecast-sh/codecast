"use client";
import { ActiveSessionBadge } from "../LivenessDot";
import type { TaskItem } from "../../store/inboxStore";
import { useTaskActiveSession } from "./taskActiveSession";

// The one session a task row points at: the live one when a session is
// working it, else the session the task came from. Clicking opens it beside.
export function TaskSessionBadge({ task, compact, className }: { task: TaskItem; compact?: boolean; className?: string }) {
  const activeSession = useTaskActiveSession(task._id);
  if (activeSession) return <ActiveSessionBadge session={activeSession} compact={compact} className={className} />;
  const origin = task.origin_session;
  if (!origin) return null;
  return (
    <ActiveSessionBadge
      session={{
        _id: origin.conversation_id,
        session_id: origin.session_id,
        title: origin.title,
        started_by: origin.started_by,
        last_message_at: origin.last_message_at,
      }}
      dormant
      compact={compact}
      className={className}
    />
  );
}
