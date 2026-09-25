import Link from "next/link";
import { ShortId } from "../../ShortId";
import { useInboxStore, type TaskDetail } from "../../../store/inboxStore";
import { useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { useTaskRow } from "../../../hooks/useThreadPreviews";
import type { ThreadCardModel } from "../../../lib/threadCards";
import { rowOf, taskIdOf } from "../../../lib/threadRows";
import { TaskStatusBadge } from "../../TaskStatusBadge";
import { Badge } from "../../ui/badge";
import { Avatar, TaskCommentStream, TimeAgo } from "../../tasks/TaskCommentStream";
import { IssueLink } from "../../tasks/IssueLink";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { useTailPin } from "../cardWindow";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The task kind: the task's comment stream. The row is the short id, the
// title and the newest reply that is news (the server picks it: a teammate's
// question outranks an agent's later notes). Open, the status row carries the
// task's metadata, the description sits folded under a disclosure (the reader
// wrote it or has seen it; the title is on the row), and the stream shows
// what is NEW since the reader's last visit under a divider, the earlier
// comments one click away, then the same composer the task page uses
// (components/tasks/TaskCommentStream), fed by the task detail query so the
// optimistic reply and the server echo land in tasks[id].comments exactly as
// they do on the task page.

/** Short id AND title: the head label is the one column every kind shares,
 *  and a bare id is unscannable in a mixed list. The status rides along as
 *  a small badge so a done task reads as done before it is opened. */
export function TaskLabel({ card }: { card: ThreadCardModel }) {
  const task = useTaskRow(taskIdOf(card));
  return (
    <>
      <span className="font-mono th-card-task-id">{task?.short_id ?? "task"}</span>
      {task?.external && <IssueLink external={task.external} />}
      {task?.title && <span className="th-card-task-name">{task.title}</span>}
      {task?.status && <TaskStatusBadge status={task.status} />}
    </>
  );
}

/** The status row: priority, assignee, plan, age. */
export function TaskMeta({ card }: { card: ThreadCardModel }) {
  const task = useTaskRow(taskIdOf(card));
  if (!task) return null;
  return (
    <div className="th-card-taskrow">
      {task.priority && (
        <Badge variant="outline" className="text-[10px] px-1">{task.priority}</Badge>
      )}
      {task.assignee_info?.name && (
        <span className="th-task-meta" title={`Assigned to ${task.assignee_info.name}`}>
          <Avatar name={task.assignee_info.name} image={task.assignee_info.image} />
          {task.assignee_info.name.split(" ")[0]}
        </span>
      )}
      {task.plan?.short_id && (
        <Link href={`/plans/${task.plan._id}`} className="th-task-meta" title={task.plan.title}>
          <ShortId id={task.plan.short_id} />
        </Link>
      )}
      <span className="th-task-meta th-task-meta-age">
        created <TimeAgo ts={task.created_at} />
      </span>
    </div>
  );
}

export function TaskExpanded({ card, seen, frozenReadAt, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const row = rowOf(card);
  const taskId = taskIdOf(card);
  // The detail feeder fills tasks[id].comments with the full server set; the
  // page's own query, so a reply here reconciles the same way it does there.
  useSyncTaskDetail(taskId);
  const task = useTaskRow(taskId);

  const commentCount = task?.comments?.length ?? 0;

  // The read law: the row is open and the reader is here (`seen`) — and the
  // store holds the stream. Never while it holds nothing for an unread
  // stream: on a cold cache the body renders empty, the newest comment never
  // shown. The count dep fires the mark once the detail feeder answers.
  useWatchEffect(() => {
    if (!seen) return;
    if (row.unread > 0 && commentCount === 0) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("task", row.root_key);
  }, [seen, row.root_key, row.last_activity_at, row.last_read_at, row.unread, commentCount]);

  // The wrapper IS the capped scroller; pinned to the tail so the newest
  // comment — the one that brought the reader here — is what shows first.
  const comments = task?.comments ?? EMPTY_COMMENTS;
  const pinRef = useTailPin(comments.length ? `${comments[comments.length - 1]._id}|${comments.length}` : "");

  const desc = (task?.description ?? "").trim();

  return (
    <div ref={pinRef} className="th-card-open th-card-open-task">
      {desc && (
        <details className="th-task-desc">
          <summary>Description</summary>
          <MarkdownRenderer content={desc} className="text-sm text-sol-text prose-sm prose-invert max-w-none" />
        </details>
      )}
      {/* The input is always ready; the focus grab rides only the reader's
          own `r`, so opening a row never steals the keyboard from the walk. */}
      <TaskCommentStream shortId={task?.short_id} comments={comments} composerAutoOpen composerAutoFocus={focusComposer} newSince={frozenReadAt} clampComments />
    </div>
  );
}

const EMPTY_COMMENTS: NonNullable<TaskDetail["comments"]> = [];
