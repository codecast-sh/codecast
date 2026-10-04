"use client";

// A task read and answered inside another surface: its description folded
// under a disclosure, then the comment stream with the same composer the task
// page uses. The Threads page's task rows and a session's task chip both draw
// it, so a task reads the same wherever it is embedded. The detail feeder
// fills tasks[id].comments, so a reply here reconciles exactly as it does on
// the task page.

import type { ReactNode } from "react";
import { type TaskDetail } from "../../store/inboxStore";
import { useSyncTaskDetail } from "../../hooks/useSyncTasks";
import { useTaskRow } from "../../hooks/useThreadPreviews";
import { TaskCommentStream } from "./TaskCommentStream";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import "../threads/threads.css";

const EMPTY_COMMENTS: NonNullable<TaskDetail["comments"]> = [];

export function TaskInlineThread({ taskId, newSince, focusComposer = false, ownerSessionId, children }: {
  taskId: string;
  /** The task's owning session, when the surface knows it (the comment box says it will see the comment). */
  ownerSessionId?: string | null;
  /** The reader's frozen unread boundary; unset shows the whole stream. */
  newSince?: number;
  focusComposer?: boolean;
  /** Between the description and the comments (a chip's subtask list). */
  children?: ReactNode;
}) {
  useSyncTaskDetail(taskId);
  const task = useTaskRow(taskId);
  const desc = (task?.description ?? "").trim();
  return (
    <>
      {desc && (
        <details className="th-task-desc">
          <summary>Description</summary>
          <MarkdownRenderer content={desc} className="text-sm text-sol-text prose-sm prose-invert max-w-none" />
        </details>
      )}
      {children}
      <TaskCommentStream shortId={task?.short_id} comments={task?.comments ?? EMPTY_COMMENTS} composerAutoOpen composerAutoFocus={focusComposer} newSince={newSince} clampComments ownerSessionId={ownerSessionId} />
    </>
  );
}
