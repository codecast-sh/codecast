"use client";

// The task page's Session section: the one session that owns this task
// (convex lib/taskOwner.ts), read and answered right here. The head is the
// task page's own session row (face, name, live mark, pinned state, Open
// beside); under it the session's newest messages and its composer, drawn by
// the same SessionInlineThread the Threads page uses. Opening the session
// itself is the row, so the page never draws a second way to get there.

import { useMemo } from "react";
import { TaskSessionRow, type TaskLinkedSession } from "../tasks/TaskSessionList";
import { SessionInlineThread } from "../conversation/SessionInlineThread";
import { useSessionOnScreen } from "../../lib/workUnit";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";

function Heading({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <div className="text-xs font-medium text-sol-text-dim">Session</div>
      {children}
    </div>
  );
}

export function TaskSessionSection({ session, task, onOpen, active, rowOnly = false }: {
  session: TaskLinkedSession;
  task: { short_id?: string | null; status?: string | null };
  onOpen: (conv: TaskLinkedSession) => void;
  /** The page is the reader's focus: its messages count as seen. */
  active: boolean;
  /** Just the session row (the task list's hover peek): no live thread. */
  rowOnly?: boolean;
}) {
  const now = useCoarseNow(30_000);
  // The session's own page already on screen (a pane beside this one): the
  // thread and its composer live there, and two composers on one
  // conversation would race for its draft.
  const onScreen = useSessionOnScreen(session._id);
  const declared = useInboxStore((s) => (s.sessions[session._id] as any)?.thread_state_status ?? session.thread_state_status ?? null);
  // The thread reads its own live data (messages, managed fields); the row
  // only names the session, so wake on the fields it reads, never on the
  // heartbeat churn of the whole row.
  const rowSig = useInboxStore((s) => {
    const r: any = s.sessions[session._id];
    return r ? `${r.status}|${r.session_id}|${r.agent_type}|${r.user_id}|${r.message_count}` : "";
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rowSig stands in for the churny row ref
  const inbox = useMemo(() => (useInboxStore.getState().sessions[session._id] ?? { ...session, status: "active" }) as any, [rowSig, session]);
  // The session says it is finished while the task still reads as underway:
  // the next move is the task's, so it is offered where the two meet.
  const finishedAhead = declared === "done" && (task.status === "in_progress" || task.status === "open") && !!task.short_id;

  return (
    <section data-task-session className="mb-6">
      <Heading>
        {finishedAhead && (
          <button
            type="button"
            onClick={() => void useInboxStore.getState().updateTaskStatus(task.short_id!, "in_review")}
            className="ml-auto h-5 px-2 rounded border border-sol-violet/40 bg-sol-violet/10 text-[10px] text-sol-violet hover:bg-sol-violet/20 transition-colors"
            title="The session marked its work complete"
          >
            Move to review
          </button>
        )}
      </Heading>
      <div className="rounded-lg border border-sol-border/40 bg-sol-bg-alt/20 overflow-hidden">
        <div className="-mx-px">
          <TaskSessionRow snapshot={session} onOpen={onOpen} now={now} tone="current" prominent />
        </div>
        {!onScreen && !rowOnly && (
          <div className="border-t border-sol-border/30">
            <SessionInlineThread session={inbox} seen={active} maxRows={8} foot={false} className="!border-t-0" />
          </div>
        )}
      </div>
    </section>
  );
}

/** The same section on a task nobody is working: handing it to an agent
 *  makes that session the task's owner. */
export function TaskSessionEmpty({ onStart }: { onStart: () => void }) {
  return (
    <section data-task-session className="mb-6">
      <Heading />
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-sol-border/50 px-3 py-2">
        <span className="text-xs text-sol-text-dim flex-1">No session is working on this task yet.</span>
        <button
          type="button"
          onClick={onStart}
          className="h-6 px-2.5 rounded-md border border-sol-border/60 text-[11px] text-sol-text-secondary hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors"
        >
          Hand to an agent
        </button>
      </div>
    </section>
  );
}
