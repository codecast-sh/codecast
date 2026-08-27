import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import { StatusCircle } from "./StatusCircle";

export type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type ExecutionStatus = "done" | "done_with_concerns" | "blocked" | "needs_context";

type StatusIcon = ComponentType<{ className?: string }>;

// Category glyphs: the status circle at each category's default fill (a
// team's own statuses get graduated fills via lib/taskStatuses.statusVisual).
const circle = (category: TaskStatus, fill?: number): StatusIcon =>
  function CategoryStatusIcon({ className }: { className?: string }) {
    return <StatusCircle category={category} progress={fill} className={className} />;
  };

/** The one task-status vocabulary: icon, label and colour per status. Exported
 *  because the task list, its groupers and this badge all render the same six
 *  statuses — a second copy is how they drift apart. */
export const TASK_STATUS: Record<TaskStatus, { icon: StatusIcon; label: string; color: string; bg: string; border: string }> = {
  backlog: { icon: circle("backlog"), label: "Backlog", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10", border: "border-sol-text-dim/30" },
  open: { icon: circle("open"), label: "Open", color: "text-sol-blue", bg: "bg-sol-blue/10", border: "border-sol-blue/30" },
  in_progress: { icon: circle("in_progress", 0.5), label: "In Progress", color: "text-sol-yellow", bg: "bg-sol-yellow/10", border: "border-sol-yellow/30" },
  in_review: { icon: circle("in_review", 0.75), label: "In Review", color: "text-sol-violet", bg: "bg-sol-violet/10", border: "border-sol-violet/30" },
  done: { icon: circle("done"), label: "Done", color: "text-sol-green", bg: "bg-sol-green/10", border: "border-sol-green/30" },
  dropped: { icon: circle("dropped"), label: "Dropped", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10", border: "border-sol-text-dim/30" },
};

/** The status vocabulary for a surface that must always draw something: an
 *  unknown or missing status reads as `open` rather than as a hole. Use this
 *  where the glyph is not optional (a pill, an inline row); use
 *  `getTaskStatusConfig` where the caller wants to know the status was
 *  unrecognised and render nothing. */
export const taskVisual = (status?: string | null) =>
  TASK_STATUS[(status || "open") as TaskStatus] ?? TASK_STATUS.open;

/** Work-first ordering: what you are doing, then what you could pick up, then
 *  what is finished. Drives status group order and the sort tie-breaker. */
export const TASK_STATUS_ORDER: TaskStatus[] = ["in_progress", "in_review", "open", "backlog", "done", "dropped"];

const EXEC_STATUS: Record<ExecutionStatus, { icon: LucideIcon; label: string; color: string; bg: string; border: string }> = {
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green", bg: "bg-sol-green/10", border: "border-sol-green/30" },
  done_with_concerns: { icon: AlertTriangle, label: "Concerns", color: "text-sol-yellow", bg: "bg-sol-yellow/10", border: "border-sol-yellow/30" },
  blocked: { icon: XCircle, label: "Blocked", color: "text-sol-red", bg: "bg-sol-red/10", border: "border-sol-red/30" },
  needs_context: { icon: HelpCircle, label: "Needs Context", color: "text-sol-orange", bg: "bg-sol-orange/10", border: "border-sol-orange/30" },
};

type BadgeSize = "sm" | "md";

interface TaskStatusBadgeProps {
  status: string;
  type?: "task" | "execution";
  size?: BadgeSize;
  showIcon?: boolean;
  className?: string;
}

export function TaskStatusBadge({
  status,
  type = "task",
  size = "sm",
  showIcon = true,
  className,
}: TaskStatusBadgeProps) {
  const config = type === "execution"
    ? EXEC_STATUS[status as ExecutionStatus]
    : TASK_STATUS[status as TaskStatus];

  if (!config) return null;

  const Icon = config.icon;
  const sizeClasses = size === "sm"
    ? "text-[10px] px-1.5 py-0.5 gap-1"
    : "text-xs px-2 py-0.5 gap-1.5";
  const iconSize = size === "sm" ? "w-2.5 h-2.5" : "w-3 h-3";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium whitespace-nowrap shrink-0",
        sizeClasses,
        config.bg,
        config.color,
        config.border,
        className,
      )}
    >
      {showIcon && <Icon className={iconSize} />}
      {config.label}
    </span>
  );
}

export function getTaskStatusConfig(status: string) {
  return TASK_STATUS[status as TaskStatus] ?? null;
}

export function getExecStatusConfig(status: string) {
  return EXEC_STATUS[status as ExecutionStatus] ?? null;
}

export { EXEC_STATUS };
// TaskStatus is exported at its declaration above.
export type { ExecutionStatus };
