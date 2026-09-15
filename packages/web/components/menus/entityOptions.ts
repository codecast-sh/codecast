import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  CircleDot,
  CircleDotDashed,
  Minus,
  PauseCircle,
  XCircle,
} from "lucide-react";
import { DOC_TYPES, DOC_TYPE_LABELS } from "@codecast/shared/docs";

// The one place status/priority/type vocabularies live. The command palette's
// drill-in submenus and the right-click context menus both render from these
// tables, so an added status or relabeled priority shows up everywhere at once.

export type EntityOption = {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  color?: string;
};

export const STATUS_OPTIONS: EntityOption[] = [
  { key: "backlog", icon: CircleDotDashed, label: "Backlog", color: "text-neutral-500" },
  { key: "open", icon: Circle, label: "Open", color: "text-blue-400" },
  { key: "in_progress", icon: CircleDot, label: "In Progress", color: "text-yellow-400" },
  { key: "in_review", icon: CircleDot, label: "In Review", color: "text-violet-400" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-green-400" },
  { key: "dropped", icon: XCircle, label: "Dropped", color: "text-neutral-500" },
];

export const PRIORITY_OPTIONS: EntityOption[] = [
  { key: "urgent", icon: AlertTriangle, label: "Urgent", color: "text-red-400" },
  { key: "high", icon: ArrowUp, label: "High", color: "text-orange-400" },
  { key: "medium", icon: Minus, label: "Medium", color: "text-neutral-400" },
  { key: "low", icon: ArrowDown, label: "Low", color: "text-neutral-500" },
  { key: "none", icon: Minus, label: "None", color: "text-neutral-600" },
];

export const PLAN_STATUS_OPTIONS: EntityOption[] = [
  { key: "draft", icon: Circle, label: "Draft", color: "text-neutral-500" },
  { key: "active", icon: CircleDot, label: "Active", color: "text-cyan-400" },
  { key: "paused", icon: PauseCircle, label: "Paused", color: "text-yellow-400" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-green-400" },
  { key: "abandoned", icon: XCircle, label: "Abandoned", color: "text-neutral-500" },
];

// Derived from the shared DOC_TYPES tuple, so the palette and context menus
// list exactly the types the schema accepts, in the same order as the docs
// page tabs and the create modal.
export const DOC_TYPE_OPTIONS: EntityOption[] = DOC_TYPES.map((key) => ({ key, label: DOC_TYPE_LABELS[key] }));
