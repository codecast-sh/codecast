import { useEffect } from "react";
import { useInboxStore, useTrackedStore, type TaskDetail, type ThreadInboxRow } from "../../../store/inboxStore";
import { useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { TaskStatusBadge } from "../../TaskStatusBadge";
import { Badge } from "../../ui/badge";
import { TaskCommentStream } from "../../tasks/TaskCommentStream";
import { useThreadsPage } from "../threadsContext";

// The task kind: a task's comment stream. The collapsed card is the short id,
// the title, the status and the latest comment; expanded, the comments and
// the same composer the task page uses (components/tasks/TaskCommentStream),
// fed by the task detail query so the optimistic reply and the server echo
// land in tasks[id].comments exactly as they do on the task page.

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
  return `${t.short_id}|${t.title}|${t.status}|${t.comments?.length ?? 0}|${last?._id ?? ""}|${last?.text?.length ?? 0}`;
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

export function TaskExpanded({ card, present }: { card: ThreadCardModel; present: boolean; frozenReadAt: number }) {
  const row = rowOf(card);
  const taskId = taskIdOf(card);
  // The detail feeder fills tasks[id].comments with the full server set; the
  // page's own query, so a reply here reconciles the same way it does there.
  useSyncTaskDetail(taskId);
  const task = useTaskRow(taskId);

  useEffect(() => {
    if (!present) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("task", row.root_key);
  }, [present, row.root_key, row.last_activity_at, row.last_read_at, row.unread]);

  return (
    <div className="th-card-open th-card-open-task">
      <TaskCommentStream shortId={task?.short_id} comments={task?.comments ?? []} composerAutoOpen />
    </div>
  );
}
