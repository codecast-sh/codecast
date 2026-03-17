"use client";

import { useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
  MessageSquare,
  RotateCcw,
  Clock,
  Target,
} from "lucide-react";
import { SlideOutPanel } from "./SlideOutPanel";
import { useSlideOutStore } from "../store/slideOutStore";
import { TaskStatusBadge, getExecStatusConfig } from "./TaskStatusBadge";
import { toast } from "sonner";

const api = _api as any;

const TASK_STATUS_CONFIG: Record<
  string,
  { icon: typeof Circle; color: string; label: string }
> = {
  draft: { icon: CircleDotDashed, color: "text-sol-text-dim", label: "Draft" },
  open: { icon: Circle, color: "text-sol-blue", label: "Open" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow", label: "In Progress" },
  in_review: { icon: CircleDot, color: "text-sol-violet", label: "In Review" },
  done: { icon: CheckCircle2, color: "text-sol-green", label: "Done" },
  dropped: { icon: XCircle, color: "text-sol-text-dim", label: "Dropped" },
};

const STATUS_CYCLE = ["open", "in_progress", "in_review", "done"];
const PRIORITY_CYCLE = ["low", "medium", "high", "urgent"];

const PRIORITY_CONFIG: Record<
  string,
  { icon: typeof Minus; color: string; label: string }
> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red", label: "Urgent" },
  high: { icon: ArrowUp, color: "text-sol-orange", label: "High" },
  medium: { icon: Minus, color: "text-sol-text-muted", label: "Medium" },
  low: { icon: ArrowDown, color: "text-sol-text-dim", label: "Low" },
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function TaskContent({ taskId }: { taskId: string }) {
  const isShortId = taskId.startsWith("ct-");
  const task = useQuery(
    api.tasks.webGet,
    isShortId ? { short_id: taskId } : { id: taskId }
  );
  const webUpdate = useMutation(api.tasks.webUpdate);
  const { open } = useSlideOutStore();

  const cycleStatus = useCallback(async () => {
    if (!task) return;
    const idx = STATUS_CYCLE.indexOf(task.status);
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
    try {
      await webUpdate({ short_id: task.short_id, status: next });
    } catch {
      toast.error("Failed to update status");
    }
  }, [task, webUpdate]);

  const cyclePriority = useCallback(async () => {
    if (!task) return;
    const current = task.priority || "medium";
    const idx = PRIORITY_CYCLE.indexOf(current);
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
    try {
      await webUpdate({ short_id: task.short_id, priority: next });
    } catch {
      toast.error("Failed to update priority");
    }
  }, [task, webUpdate]);

  const retryTask = useCallback(async () => {
    if (!task) return;
    try {
      await webUpdate({ short_id: task.short_id, status: "open", execution_status: "" });
      toast.success("Task reset to open");
    } catch {
      toast.error("Failed to retry task");
    }
  }, [task, webUpdate]);

  if (task === undefined) {
    return (
      <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">
        Loading...
      </div>
    );
  }

  if (task === null) {
    return (
      <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">
        Task not found
      </div>
    );
  }

  const sc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.open;
  const StatusIcon = sc.icon;
  const pc = PRIORITY_CONFIG[task.priority || "medium"];
  const PriorityIcon = pc?.icon || Minus;
  const hasExec = task.execution_status && !!getExecStatusConfig(task.execution_status);
  const isFailed = task.execution_status === "blocked" || task.execution_status === "needs_context";

  return (
    <div className="p-4 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-mono text-sol-text-dim">
            {task.short_id}
          </span>
          {hasExec && (
            <TaskStatusBadge status={task.execution_status} type="execution" />
          )}
        </div>

        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-sol-text leading-snug">
              {task.title}
            </h3>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={cycleStatus}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sol-border/20 hover:border-sol-border/40 bg-sol-bg-alt/20 hover:bg-sol-bg-alt/40 transition-colors text-left"
          title="Click to cycle status"
        >
          <StatusIcon className={`w-3.5 h-3.5 ${sc.color}`} />
          <div>
            <div className="text-[9px] text-sol-text-dim uppercase tracking-wider">
              Status
            </div>
            <div className={`text-xs font-medium ${sc.color}`}>
              {sc.label}
            </div>
          </div>
        </button>

        <button
          onClick={cyclePriority}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sol-border/20 hover:border-sol-border/40 bg-sol-bg-alt/20 hover:bg-sol-bg-alt/40 transition-colors text-left"
          title="Click to cycle priority"
        >
          <PriorityIcon className={`w-3.5 h-3.5 ${pc?.color || "text-sol-text-dim"}`} />
          <div>
            <div className="text-[9px] text-sol-text-dim uppercase tracking-wider">
              Priority
            </div>
            <div className={`text-xs font-medium ${pc?.color || "text-sol-text-dim"}`}>
              {pc?.label || "Medium"}
            </div>
          </div>
        </button>
      </div>

      {isFailed && (
        <button
          onClick={retryTask}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-sol-orange/30 bg-sol-orange/5 hover:bg-sol-orange/10 text-sol-orange text-xs font-medium transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Retry Task
        </button>
      )}

      {task.description && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-1.5">
            Description
          </div>
          <p className="text-xs text-sol-text-muted leading-relaxed whitespace-pre-wrap">
            {task.description}
          </p>
        </div>
      )}

      {task.blocked_by?.length > 0 && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-1.5">
            Blocked By
          </div>
          <div className="space-y-1">
            {task.blocked_by.map((b: string, i: number) => (
              <div
                key={i}
                className="text-xs text-sol-text-muted px-2 py-1 rounded bg-sol-bg-alt/30 border border-sol-border/10"
              >
                {b}
              </div>
            ))}
          </div>
        </div>
      )}

      {task.acceptance_criteria?.length > 0 && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-1.5">
            Acceptance Criteria
          </div>
          <div className="space-y-1">
            {task.acceptance_criteria.map((ac: string, i: number) => (
              <div
                key={i}
                className="flex items-start gap-1.5 text-xs text-sol-text-muted"
              >
                <span className="text-sol-text-dim mt-px">-</span>
                <span>{ac}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {task.plan && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-1.5">
            Plan
          </div>
          <button
            onClick={() => open("plan", task.plan._id)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sol-cyan/20 bg-sol-cyan/5 hover:bg-sol-cyan/10 transition-colors w-full text-left"
          >
            <Target className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-xs text-sol-cyan truncate">
                {task.plan.title}
              </div>
              <div className="text-[10px] text-sol-text-dim font-mono">
                {task.plan.short_id}
              </div>
            </div>
          </button>
        </div>
      )}

      {task.files_changed?.length > 0 && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-1.5">
            Files Changed
          </div>
          <div className="flex flex-wrap gap-1">
            {task.files_changed.map((f: string, i: number) => (
              <span
                key={i}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt text-sol-text-dim border border-sol-border/10"
              >
                {f.split("/").pop()}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 text-[10px] text-sol-text-dim/50 font-mono">
        {task.created_at && (
          <span>Created {getRelativeTime(task.created_at)}</span>
        )}
        {task._creationTime && !task.created_at && (
          <span>Created {getRelativeTime(task._creationTime)}</span>
        )}
        {task.updated_at && (
          <span>Updated {getRelativeTime(task.updated_at)}</span>
        )}
        {task.attempt_count > 0 && (
          <span>{task.attempt_count} attempt{task.attempt_count !== 1 ? "s" : ""}</span>
        )}
      </div>

      {task.comments?.length > 0 && (
        <div>
          <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <MessageSquare className="w-3 h-3" />
            Comments ({task.comments.length})
          </div>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {task.comments.map((c: any) => (
              <div
                key={c._id}
                className="px-3 py-2 rounded-lg bg-sol-bg-alt/30 border border-sol-border/10"
              >
                <div className="flex items-center gap-2 mb-1">
                  {c.comment_type && (
                    <span className="text-[9px] font-medium uppercase tracking-wider text-sol-text-dim bg-sol-bg-highlight px-1 py-px rounded">
                      {c.comment_type}
                    </span>
                  )}
                  <span className="text-[10px] text-sol-text-dim/50 font-mono ml-auto">
                    {c.created_at
                      ? getRelativeTime(c.created_at)
                      : c._creationTime
                        ? getRelativeTime(c._creationTime)
                        : ""}
                  </span>
                </div>
                <p className="text-xs text-sol-text-muted leading-relaxed whitespace-pre-wrap">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <Link
        href={`/tasks/${task._id}`}
        className="flex items-center gap-1.5 text-xs text-sol-cyan hover:text-sol-text transition-colors pt-2 border-t border-sol-border/15"
      >
        <ExternalLink className="w-3 h-3" />
        Open full task
      </Link>
    </div>
  );
}

export function TaskSlideOut() {
  const { type, id, close } = useSlideOutStore();
  const isOpen = type === "task" && !!id;

  return (
    <SlideOutPanel open={isOpen} onClose={close} title="Task">
      {isOpen && id && <TaskContent taskId={id} />}
    </SlideOutPanel>
  );
}
