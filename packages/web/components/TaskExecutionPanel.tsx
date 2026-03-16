"use client";

import { TaskStatusBadge } from "./TaskStatusBadge";
import { RetryTaskButton } from "./RetryTaskButton";
import { Clock, RotateCw, User, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskExecution {
  _id: string;
  short_id: string;
  title: string;
  status: string;
  execution_status?: string;
  retry_count?: number;
  max_retries?: number;
  assigned_agent?: string;
  _creationTime: number;
  updated_at?: number;
  comments?: Array<{ text: string; author: string; created_at: number; type?: string }>;
}

interface TaskExecutionPanelProps {
  task: TaskExecution;
  className?: string;
  onRetry?: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function TaskExecutionPanel({ task, className, onRetry }: TaskExecutionPanelProps) {
  const retries = task.retry_count || 0;
  const maxRetries = task.max_retries || 3;
  const retriesExhausted = retries >= maxRetries;
  const progressComments = (task.comments || []).filter((c) => c.type === "progress" || c.type === "blocker");

  return (
    <div className={cn("rounded-lg border border-sol-border bg-sol-bg-deeper p-4 space-y-4", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TaskStatusBadge status={task.status} size="md" />
          {task.execution_status && (
            <TaskStatusBadge status={task.execution_status} type="execution" size="md" />
          )}
        </div>
        <RetryTaskButton task={task} onRetry={onRetry} />
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <div className="space-y-1">
          <div className="text-sol-text-dim flex items-center gap-1">
            <RotateCw className="w-3 h-3" /> Retries
          </div>
          <div className={cn("font-mono font-medium", retriesExhausted ? "text-sol-red" : "text-sol-text")}>
            {retries}/{maxRetries}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-sol-text-dim flex items-center gap-1">
            <User className="w-3 h-3" /> Agent
          </div>
          <div className="font-mono text-sol-text truncate">
            {task.assigned_agent || <span className="text-sol-text-dim">unassigned</span>}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-sol-text-dim flex items-center gap-1">
            <Clock className="w-3 h-3" /> Updated
          </div>
          <div className="font-mono text-sol-text">
            {task.updated_at ? timeAgo(task.updated_at) : timeAgo(task._creationTime)}
          </div>
        </div>
      </div>

      {retriesExhausted && (
        <div className="flex items-center gap-2 text-xs text-sol-red bg-sol-red/5 border border-sol-red/20 rounded px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Max retries exhausted. Manual intervention required.
        </div>
      )}

      {progressComments.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-sol-text-dim font-medium">
            Execution Log
          </div>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {progressComments.map((c, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="text-sol-text-dim flex-shrink-0 font-mono">
                  {new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className={cn(
                  "flex-1",
                  c.type === "blocker" ? "text-sol-red" : "text-sol-text-muted",
                )}>
                  {c.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
