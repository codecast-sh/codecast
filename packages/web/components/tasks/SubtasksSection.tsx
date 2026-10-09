"use client";

import { useMemo, useRef, useState } from "react";
import { Bot, Plus } from "lucide-react";
import { MAX_TASK_DEPTH, directChildren, isActiveTask, subtaskProgressOf, taskDepth } from "@codecast/shared/tasks";
import { useInboxStore, type TaskDetail, type TaskItem } from "../../store/inboxStore";
import { closeTaskWithGuard, createTaskAndAdopt } from "../../lib/taskActions";
import { statusVisual, taskStatusOf, useTeamTaskStatusList } from "../../lib/taskStatuses";

// Linear's sub-issue section, store-driven: progress header, live rows, and a
// quick-add whose focus survives Enter so decomposing into five subtasks is
// five titles and five Enters. Always rendered — an empty parent shows the
// input, otherwise the feature can never bootstrap from the UI.
export function SubtasksSection({ task, onNavigate }: {
  task: Pick<TaskDetail, "_id" | "short_id"> & { team_id?: string };
  onNavigate: (id: string) => void;
}) {
  const allTasks = useInboxStore((s) => s.tasks);
  const updateTask = useInboxStore((s) => s.updateTask);
  // Subtasks share the parent's workspace, so one vocabulary covers the list.
  const taskStatuses = useTeamTaskStatusList((task as any)?.team_id);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const children = useMemo(
    () =>
      directChildren(Object.values(allTasks) as TaskItem[], task._id)
        .filter((t: any) => isActiveTask(t))
        .sort((a: any, b: any) => (a.created_at || 0) - (b.created_at || 0)),
    [allTasks, task._id],
  );
  const progress = useMemo(() => subtaskProgressOf(children as any[]), [children]);
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // A subtask can't be added below the depth cap — the server would refuse and
  // strand a ghost. Compute this task's depth from the store and hide the input.
  const atMaxDepth = useMemo(() => {
    const parentOf = (id: string) => { const p = allTasks[id]?.parent_id; return p ? String(p) : undefined; };
    return taskDepth(String(task._id), parentOf) >= MAX_TASK_DEPTH;
  }, [allTasks, task._id]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    setTitle("");
    // The stub renders instantly; the altKey supersede swaps in the real row on
    // the ack, and a refusal cleans the stub up (createTaskAndAdopt).
    void createTaskAndAdopt({ title: t, parent: task.short_id });
    inputRef.current?.focus();
  };

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-xs font-medium text-sol-text-dim">Subtasks</div>
        {progress.total > 0 && (
          <>
            <span className="text-[11px] font-mono text-sol-text-muted">{progress.done}/{progress.total}</span>
            <div className="flex-1 max-w-[8rem] h-1 rounded-full bg-sol-border/30 overflow-hidden">
              <div className="h-full bg-sol-green transition-all" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
      </div>
      <div className="space-y-0.5">
        {children.map((t: any) => {
          const cfg = statusVisual(taskStatusOf(t, taskStatuses), taskStatuses);
          const RowIcon = cfg.icon;
          const closed = t.status === "done" || t.status === "dropped";
          // A stub whose server row hasn't synced yet has no real id/short_id —
          // navigating to it or toggling its status would hit a dead page or a
          // no-op lookup, so render it inert until the altKey supersede swaps
          // in the real row.
          const pending = String(t._id).startsWith("temp_");
          return (
            <div key={t._id} className="group flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-sol-bg-alt/50 transition-colors">
              <button
                onClick={() => { if (pending) return; closed ? updateTask(t.short_id, { status: "open" }) : closeTaskWithGuard(t.short_id, "done"); }}
                className="flex-shrink-0 hover:scale-125 transition-transform disabled:opacity-50"
                disabled={pending}
                title={pending ? "Saving…" : closed ? "Reopen" : "Mark done"}
              >
                <RowIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
              </button>
              <span className="text-[11px] font-mono text-sol-text-dim flex-shrink-0">{pending ? "…" : t.short_id}</span>
              {pending ? (
                <span className="flex-1 min-w-0 text-left text-xs truncate text-sol-text-dim">{t.title}</span>
              ) : (
                <button
                  onClick={() => onNavigate(t._id)}
                  className={`flex-1 min-w-0 text-left text-xs truncate transition-colors ${closed ? "text-sol-text-dim line-through" : "text-sol-text hover:text-sol-cyan"}`}
                >
                  {t.title}
                </button>
              )}
              {t.source !== "human" && t.source !== "meeting" && (
                <Bot className="w-3 h-3 text-sol-text-dim/60 flex-shrink-0" />
              )}
              {t.assignee_info?.name && (
                <span className="text-[10px] text-sol-text-dim flex-shrink-0">{t.assignee_info.name}</span>
              )}
            </div>
          );
        })}
      </div>
      {atMaxDepth ? (
        <div className="px-1.5 py-1 mt-0.5 text-[11px] text-sol-text-dim">
          Deepest level — add further steps under a higher-level task.
        </div>
      ) : (
      <div className="flex items-center gap-2 px-1.5 py-1 mt-0.5">
        <Plus className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") { setTitle(""); (e.target as HTMLInputElement).blur(); }
            e.stopPropagation();
          }}
          placeholder="Add subtask…"
          className="flex-1 bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim outline-none py-0.5"
        />
      </div>
      )}
    </div>
  );
}
