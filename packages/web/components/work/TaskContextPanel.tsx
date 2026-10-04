"use client";

// The task a session owns (convex lib/taskOwner.ts), as one item on the
// session's context rail, the plan chip's sibling: status, title, id and the
// subtask tally on the chip; opened, the task's brief, its subtasks and its
// comment thread with a composer, so the work's statement can be read and
// moved without leaving the work. The task page carries the session the
// same way (TaskSessionSection), so each face holds the other.

import { useState } from "react";
import { ArrowUpRight, Columns2 } from "lucide-react";
import { directChildren, isActiveTask, subtaskProgressOf } from "@codecast/shared/tasks";
import { ShortId } from "../ShortId";
import { RailChip, RailDetail, RailProgress } from "../ContextRail";
import { taskVisual } from "../TaskStatusBadge";
import { TaskInlineThread } from "../tasks/TaskInlineThread";
import { SubtasksSection } from "../tasks/SubtasksSection";
import { TaskStatusPicker } from "../tasks/TaskStatusPicker";
import { useTaskRow } from "../../hooks/useThreadPreviews";
import { openBeside } from "../../lib/stage";
import { taskFacePath, useSwitchFace } from "../../lib/workUnit";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";

/** "done/total" of the task's open subtasks, a plain string so the selector
 *  compares by value and wakes only when the tally moves. */
function subtaskTally(taskId: string, tasks: Record<string, unknown>): string {
  const children = directChildren(Object.values(tasks) as TaskItem[], taskId).filter((t: any) => isActiveTask(t));
  const p = subtaskProgressOf(children as any[]);
  return p.total > 0 ? `${p.done}/${p.total}` : "";
}

export function TaskContextPanel({ task: ref, sessionId }: {
  /** The session row's own snapshot of its task: paints before the store row lands. */
  task: { _id: string; short_id?: string | null; title: string; status?: string | null };
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const row = useTaskRow(ref._id);
  const task = { ...ref, ...(row ?? {}) };
  const tally = useInboxStore((s) => subtaskTally(ref._id, s.tasks as any));
  const [done, total] = tally ? tally.split("/").map(Number) : [0, 0];
  // The session says it is finished while its task still reads as underway:
  // the next move is the task's, offered on the chip and in its detail.
  const declared = useInboxStore((s) => (s.sessions[sessionId] as any)?.thread_state_status ?? null);
  const finishedAhead = declared === "done" && (task.status === "in_progress" || task.status === "open") && !!task.short_id;
  const switchFace = useSwitchFace();
  const path = taskFacePath(task);
  const { icon: StatusIcon, color, label } = taskVisual(task.status);

  return (
    <div data-cc-context-panel className="contents">
      <RailChip data-cc-rail-item="task" open={expanded} onToggle={() => setExpanded(!expanded)} title={`${task.title} · ${task.short_id ?? ""} · ${label}`}>
        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${color}`} />
        <span className="min-w-0 truncate font-medium text-sol-text">{task.title}</span>
        <span data-rail-full className="flex-shrink-0"><ShortId id={task.short_id} className="text-sol-text-dim" /></span>
        <span className="ml-auto" />
        {finishedAhead && <span className="w-1.5 h-1.5 rounded-full bg-sol-violet flex-shrink-0" aria-label="Ready for review" />}
        {total > 0 && <RailProgress done={done} total={total} bar="bg-sol-green" />}
      </RailChip>

      {expanded && (
        <RailDetail data-cc-task-detail="">
          <div className="px-4 py-2.5 space-y-2.5 max-h-[60vh] overflow-y-auto">
            <div className="flex items-center gap-3 text-[11px] min-w-0">
              <div className="-ml-2 flex-shrink-0"><TaskStatusPicker task={task as any} /></div>
              <span className="ml-auto flex items-center gap-1 flex-shrink-0">
                {finishedAhead && (
                  <button
                    type="button"
                    onClick={() => void useInboxStore.getState().updateTaskStatus(task.short_id!, "in_review")}
                    className="h-5 px-2 rounded border border-sol-violet/40 bg-sol-violet/10 text-[10px] text-sol-violet hover:bg-sol-violet/20 transition-colors"
                    title="This session marked its work complete"
                  >
                    Move to review
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => switchFace(path)}
                  className="flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                  title="Open the task here"
                >
                  <ArrowUpRight className="w-3 h-3" /> Open task
                </button>
                <button
                  type="button"
                  onClick={() => { if (!openBeside(path)) switchFace(path); }}
                  className="flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                  title="Open the task beside this session"
                >
                  <Columns2 className="w-3 h-3" /> Beside
                </button>
              </span>
            </div>
            <TaskInlineThread taskId={ref._id} ownerSessionId={sessionId}>
              {task.short_id && <SubtasksSection task={task as any} onNavigate={(id) => switchFace(`/tasks/${id}`)} />}
            </TaskInlineThread>
          </div>
        </RailDetail>
      )}
    </div>
  );
}
