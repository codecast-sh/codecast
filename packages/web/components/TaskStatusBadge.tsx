import {
  CheckCircle2,
  Circle,
  CircleDot,
  CircleDotDashed,
  XCircle,
  AlertTriangle,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type ExecutionStatus = "done" | "done_with_concerns" | "blocked" | "needs_context";

const TASK_STATUS: Record<TaskStatus, { icon: LucideIcon; label: string; color: string; bg: string; border: string }> = {
  backlog: { icon: CircleDotDashed, label: "Backlog", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10", border: "border-sol-text-dim/30" },
  open: { icon: Circle, label: "Open", color: "text-sol-blue", bg: "bg-sol-blue/10", border: "border-sol-blue/30" },
  in_progress: { icon: CircleDot, label: "In Progress", color: "text-sol-yellow", bg: "bg-sol-yellow/10", border: "border-sol-yellow/30" },
  in_review: { icon: CircleDot, label: "In Review", color: "text-sol-violet", bg: "bg-sol-violet/10", border: "border-sol-violet/30" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green", bg: "bg-sol-green/10", border: "border-sol-green/30" },
  dropped: { icon: XCircle, label: "Dropped", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10", border: "border-sol-text-dim/30" },
};

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
        "inline-flex items-center rounded-full border font-medium",
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

export { TASK_STATUS, EXEC_STATUS };
export type { TaskStatus, ExecutionStatus };
