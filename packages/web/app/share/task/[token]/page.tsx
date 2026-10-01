"use client";
// /share/task/<token>: one task as a stranger holding its link reads it.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { ShortId } from "../../../../components/ShortId";
import { TaskStatusBadge } from "../../../../components/TaskStatusBadge";
import { MarkdownRenderer } from "../../../../components/tools/MarkdownRenderer";
import { AvatarImg } from "../../../../lib/avatarCache";
import { taskPriorityBadge } from "../../../../lib/taskPriority";
import { SharedObjectPage } from "../../SharedObjectPage";

type SharedTask = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedTask>>;

export default function SharedTaskPage() {
  return (
    <SharedObjectPage<SharedTask> kind="task" query={api.publicShare.getSharedTask} noun="task">
      {(task) => {
        const priority = taskPriorityBadge(task.priority);
        return (
          <>
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <TaskStatusBadge status={task.status} size="md" />
                {priority && (
                  <span className={`inline-flex items-center gap-1 text-xs ${priority.color}`}>
                    <priority.icon className="w-3 h-3" />
                    {priority.label}
                  </span>
                )}
                <ShortId id={task.short_id} className="text-xs text-sol-text-dim" />
                {task.labels.map((l) => (
                  <span key={l} className="text-xs text-sol-text-dim px-1.5 py-0.5 rounded border border-sol-border/30">
                    {l}
                  </span>
                ))}
              </div>
              <h1 className="text-2xl font-semibold text-sol-text mb-3">{task.title}</h1>
              <div className="flex items-center gap-3 text-xs text-sol-text-dim flex-wrap">
                {task.user?.image && <AvatarImg src={task.user.image} alt="" className="w-5 h-5 rounded-full" />}
                {task.user?.name && <span className="text-sol-text-muted">{task.user.name}</span>}
                <span title={formatDateFull(task.created_at)}>{formatDateSmart(task.created_at)}</span>
                {task.assignee && <span>Assigned to <span className="text-sol-text-muted">{task.assignee}</span></span>}
              </div>
            </div>

            {task.description && (
              <article className="prose prose-invert max-w-none mb-8">
                <MarkdownRenderer content={task.description} />
              </article>
            )}

            {task.acceptance_criteria.length > 0 && (
              <div className="mb-8">
                <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-2">Acceptance criteria</h2>
                <ul className="space-y-1">
                  {task.acceptance_criteria.map((c, i) => (
                    <li key={i} className="text-sm text-sol-text-muted flex gap-2">
                      <span className="text-sol-cyan shrink-0">-</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {task.comments.length > 0 && (
              <div className="border-t border-sol-border/20 pt-8">
                <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-4">Activity</h2>
                <div className="space-y-5">
                  {task.comments.map((c, i) => (
                    <div key={i}>
                      <div className="flex items-center gap-2 text-xs text-sol-text-dim mb-1">
                        <span className="text-sol-text-muted">{c.author}</span>
                        <span className="text-sol-cyan/70">{c.comment_type}</span>
                        <span title={formatDateFull(c.created_at)}>{formatDateSmart(c.created_at)}</span>
                      </div>
                      <div className="prose prose-invert prose-sm max-w-none">
                        <MarkdownRenderer content={c.text} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
