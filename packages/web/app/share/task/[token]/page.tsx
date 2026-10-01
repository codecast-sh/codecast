"use client";
// /share/task/<token>: one task as a stranger holding its link reads it.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { taskPriorityBadge } from "../../../../lib/taskPriority";
import { Bullets, Pill, Prose, Section, ShareHead, SharedObjectPage, StatusPill, humanize } from "../../SharedObjectPage";

type SharedTask = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedTask>>;

export default function SharedTaskPage() {
  return (
    <SharedObjectPage<SharedTask> kind="task" query={api.publicShare.getSharedTask} noun="task">
      {(task) => {
        const priority = taskPriorityBadge(task.priority);
        return (
          <>
            <ShareHead
              badges={
                <>
                  <StatusPill status={task.status} />
                  {priority && <Pill tone={task.priority === "urgent" ? "red" : task.priority === "high" ? "orange" : "muted"}>{priority.label}</Pill>}
                  <Pill quiet>{task.short_id}</Pill>
                  {task.labels.map((l) => (
                    <Pill key={l} quiet>
                      {l}
                    </Pill>
                  ))}
                </>
              }
              title={task.title}
              user={task.user}
              at={task.created_at}
              meta={task.assignee ? <span>assigned to <strong>{task.assignee}</strong></span> : null}
            />
            {task.description && (
              <Section title="Description">
                <Prose content={task.description} />
              </Section>
            )}
            {task.acceptance_criteria.length > 0 && (
              <Section title="Done when">
                <Bullets items={task.acceptance_criteria} tone="green" />
              </Section>
            )}
            {task.comments.length > 0 && (
              <Section title="Activity" count={task.comments.length}>
                <div style={{ display: "grid", gap: 28 }}>
                  {task.comments.map((c, i) => (
                    <div key={i}>
                      <div className="share-meta" style={{ marginTop: 0, marginBottom: 8 }}>
                        <strong>{c.author}</strong>
                        <span>{humanize(c.comment_type)}</span>
                        <span title={formatDateFull(c.created_at)}>{formatDateSmart(c.created_at)}</span>
                      </div>
                      <Prose content={c.text} compact />
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
