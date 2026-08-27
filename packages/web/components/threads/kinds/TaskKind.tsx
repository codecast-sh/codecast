import { useEffect, useState } from "react";
import Link from "next/link";
import { useInboxStore, useTrackedStore, type TaskDetail, type ThreadInboxRow } from "../../../store/inboxStore";
import { useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { TaskStatusBadge } from "../../TaskStatusBadge";
import { Badge } from "../../ui/badge";
import { Avatar, TaskCommentStream, TimeAgo } from "../../tasks/TaskCommentStream";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";

// The task kind: the task itself, then its comment stream. The collapsed card
// is the short id, the title, the status and the latest comment; expanded,
// the status row grows the task's metadata (priority, assignee, plan, age),
// the description renders clamped with its own expand, and below them the
// newest few comments and the same composer the task page uses
// (components/tasks/TaskCommentStream), fed by the task detail query so the
// optimistic reply and the server echo land in tasks[id].comments exactly as
// they do on the task page.

/** The expanded card shows this many newest comments; the rest sit behind a
 *  "show earlier" reveal. The thread's news is its tail — the full stream is
 *  one click away here and lives whole on the task page. */
const CARD_COMMENT_LIMIT = 5;

function rowOf(card: ThreadCardModel): ThreadInboxRow {
  return card.source as ThreadInboxRow;
}

function taskIdOf(card: ThreadCardModel): string {
  const row = rowOf(card);
  return String(row.task_id ?? row.root_key);
}

/** The task row, woken only by the fields a card shows. */
function taskSig(t: TaskDetail | undefined): string {
  if (!t) return "";
  const last = t.comments?.[t.comments.length - 1];
  return `${t.short_id}|${t.title}|${t.status}|${t.priority ?? ""}|${t.assignee_info?.name ?? ""}|${t.plan?.short_id ?? ""}|${(t.description ?? "").length}|${t.comments?.length ?? 0}|${last?._id ?? ""}|${last?.text?.length ?? 0}`;
}

function useTaskRow(taskId: string): TaskDetail | undefined {
  const s = useTrackedStore([(s) => taskSig(s.tasks[taskId] as TaskDetail | undefined)]);
  return s.tasks[taskId] as TaskDetail | undefined;
}

/** Short id AND title: the head label is the one column every kind shares,
 *  and a bare id is unscannable in a mixed list. */
export function TaskLabel({ card }: { card: ThreadCardModel }) {
  const task = useTaskRow(taskIdOf(card));
  return (
    <>
      <span className="font-mono th-card-task-id">{task?.short_id ?? "task"}</span>
      {task?.title && <span className="th-card-task-name">{task.title}</span>}
    </>
  );
}

export function TaskRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const row = rowOf(card);
  const task = useTaskRow(taskIdOf(card));
  const { toggle } = useThreadsPage();
  const last = task?.comments?.[task.comments.length - 1];
  const lastReply = row.last_reply;
  const count = task?.comments?.length ?? 0;
  return (
    <>
      {task ? (
        <div className="th-card-root th-card-taskrow">
          <TaskStatusBadge status={task.status} />
          {/* Expanded, the row carries the task's metadata; collapsed it
              stays one badge so the list scans. */}
          {expanded && (
            <>
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
                <Link href={`/plans/${task.plan._id}`} className="th-task-meta font-mono" title={task.plan.title}>
                  {task.plan.short_id}
                </Link>
              )}
              <span className="th-task-meta th-task-meta-age">
                created <TimeAgo ts={task.created_at} />
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="th-card-root th-card-ghost" aria-hidden="true">
          <div className="ch-skel-line ch-skel-head" />
        </div>
      )}
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={() => toggle(card)}>
          <span className="th-card-count">{summaryCount(count, "comment")}</span>
          {last?.comment_type && last.comment_type !== "note" && (
            <Badge variant="outline" className="text-[10px] px-1">{last.comment_type}</Badge>
          )}
          {lastReply && (
            <span className="th-card-preview">
              <span className="th-card-preview-name">{lastReply.author_name ?? last?.author ?? "Agent"}:</span>{" "}
              {lastReply.preview}
            </span>
          )}
        </button>
      )}
    </>
  );
}

export function TaskExpanded({ card, seen, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const row = rowOf(card);
  const taskId = taskIdOf(card);
  // The detail feeder fills tasks[id].comments with the full server set; the
  // page's own query, so a reply here reconciles the same way it does there.
  useSyncTaskDetail(taskId);
  const task = useTaskRow(taskId);

  const commentCount = task?.comments?.length ?? 0;

  // The read law: mark read only while the card's newest content has actually
  // been in the viewport (`seen`, the shell's tail sentinel), never on mount —
  // and never while the store holds nothing for an unread stream: on a cold
  // cache the body renders empty and short, so the sentinel is trivially in
  // view with the newest comment never rendered. The count dep fires the mark
  // once the detail feeder answers.
  useEffect(() => {
    if (!seen) return;
    if (row.unread > 0 && commentCount === 0) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("task", row.root_key);
  }, [seen, row.root_key, row.last_activity_at, row.last_read_at, row.unread, commentCount]);

  // The wrapper IS the capped scroller (65vh); pinned to the tail so the
  // newest comment is what shows — the read sentinel below assumes it.
  const comments = task?.comments ?? EMPTY_COMMENTS;
  const pinRef = useTailPin(comments.length ? `${comments[comments.length - 1]._id}|${comments.length}` : "");

  return (
    <>
      {/* The description sits ABOVE the scroller so the tail pin cannot bury
          it: the card leads with what the task IS, then its conversation. */}
      <TaskDescription task={task} />
      <div ref={pinRef} className="th-card-open th-card-open-task">
        {/* The input is always ready; the focus grab still rides only the
            user's own expand, so default-open cards never fight over focus. */}
        <TaskCommentStream shortId={task?.short_id} comments={comments} composerAutoOpen composerAutoFocus={focusComposer} initialLimit={CARD_COMMENT_LIMIT} />
      </div>
    </>
  );
}

/** The task's own description, clamped to a few lines under a fade until the
 *  reader asks for the rest. A short description renders whole, no toggle. */
function TaskDescription({ task }: { task: TaskDetail | undefined }) {
  const [open, setOpen] = useState(false);
  const desc = (task?.description ?? "").trim();
  if (!desc) return null;
  const clampable = desc.length > 280 || desc.split("\n").length > 4;
  return (
    <div className="th-task-desc">
      <div className={clampable && !open ? "th-task-desc-clip" : undefined}>
        <MarkdownRenderer content={desc} className="text-sm text-sol-text prose-sm prose-invert max-w-none" />
      </div>
      {clampable && (
        <button type="button" className="th-task-desc-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

const EMPTY_COMMENTS: NonNullable<TaskDetail["comments"]> = [];
