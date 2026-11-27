import { AlertTriangle, ArrowDown, ArrowUp, Minus, type LucideIcon } from "lucide-react";

export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

// How a task's priority reads everywhere it shows: task rows, plan boards and
// panels, the doc and project pages, and the inline task pills and cards.
export const TASK_PRIORITY: Record<TaskPriority, { icon: LucideIcon; label: string; color: string }> = {
  urgent: { icon: AlertTriangle, label: "Urgent", color: "text-sol-red" },
  high: { icon: ArrowUp, label: "High", color: "text-sol-orange" },
  medium: { icon: Minus, label: "Medium", color: "text-sol-text-muted" },
  low: { icon: ArrowDown, label: "Low", color: "text-sol-text-dim" },
  none: { icon: Minus, label: "None", color: "text-sol-text-dim" },
};

/** For a surface that always draws a priority: an unset or unknown value reads as `fallback`. */
export function taskPriority(priority: string | null | undefined, fallback: TaskPriority = "medium") {
  return TASK_PRIORITY[priority as TaskPriority] ?? TASK_PRIORITY[fallback];
}

/** For a surface that shows a priority only when one is set: undefined for unset, "none" or unknown. */
export function taskPriorityBadge(priority: string | null | undefined) {
  return priority && priority !== "none" ? TASK_PRIORITY[priority as TaskPriority] : undefined;
}
