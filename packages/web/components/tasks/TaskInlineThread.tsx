"use client";

// A task read and answered inside another surface: its description folded
// under a disclosure, then the comment stream with the same composer the task
// page uses. The Threads page's task rows and a session's task chip both draw
// it, so a task reads the same wherever it is embedded. The detail feeder
// fills the task's thread in the store (taskComments), so a reply here
// reconciles exactly as it does on the task page.

import type { ReactNode } from "react";
import { FilePathContext, useFolderPathContext } from "../../lib/filePathLinks";
import { useSyncTaskDetail, useTaskComments } from "../../hooks/useSyncTasks";
import { useTaskRow } from "../../hooks/useThreadPreviews";
import { TaskCommentStream, type TaskOwnerRef } from "./TaskCommentStream";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import "../threads/threads.css";

export function TaskInlineThread({ taskId, newSince, focusComposer = false, owner, children }: {
  taskId: string;
  /** The task's owning session, when the surface knows it (the comment box says it will see the comment). */
  owner?: TaskOwnerRef | null;
  /** The reader's frozen unread boundary; unset shows the whole stream. */
  newSince?: number;
  focusComposer?: boolean;
  /** Between the description and the comments (a chip's subtask list). */
  children?: ReactNode;
}) {
  useSyncTaskDetail(taskId);
  const task = useTaskRow(taskId);
  const comments = useTaskComments(taskId);
  const desc = (task?.description ?? "").trim();
  // A path the description or a comment cites is relative to the task's project.
  const fileCtx = useFolderPathContext(task?.project_path);
  return (
    <FilePathContext.Provider value={fileCtx}>
      {desc && (
        <details className="th-task-desc">
          <summary>Description</summary>
          <MarkdownRenderer content={desc} className="text-sm text-sol-text prose-sm prose-invert max-w-none" />
        </details>
      )}
      {children}
      <TaskCommentStream shortId={task?.short_id} comments={comments} composerAutoOpen composerAutoFocus={focusComposer} newSince={newSince} clampComments owner={owner} />
    </FilePathContext.Provider>
  );
}
