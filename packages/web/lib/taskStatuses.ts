"use client";
/**
 * Client side of per-team task statuses (Linear-style; contract in
 * @codecast/shared/tasks/statuses.ts). The store's `teams` list carries each
 * team's `task_statuses`; everything here resolves a task's canonical category
 * plus optional `status_id` into the team's named status, and shapes that list
 * for the surfaces that render or pick statuses (board columns, group headers,
 * palette / context-menu / dropdown options).
 */
import { createElement, useMemo, type ComponentType } from "react";
import { useInboxStore } from "../store/inboxStore";
import { TASK_STATUS, TASK_STATUS_ORDER } from "../components/TaskStatusBadge";
import { StatusCircle } from "../components/StatusCircle";
import {
  DEFAULT_TASK_STATUSES,
  TASK_STATUS_CATEGORIES,
  resolveTaskStatus,
  teamTaskStatuses,
  type TaskStatusCategory,
  type TeamTaskStatus,
} from "@codecast/shared/tasks";

// Accent classes spelled out literally so Tailwind's scanner keeps them.
export const STATUS_COLOR_CLASSES: Record<string, { color: string; bg: string; border: string }> = {
  blue: { color: "text-sol-blue", bg: "bg-sol-blue/10", border: "border-sol-blue/30" },
  green: { color: "text-sol-green", bg: "bg-sol-green/10", border: "border-sol-green/30" },
  yellow: { color: "text-sol-yellow", bg: "bg-sol-yellow/10", border: "border-sol-yellow/30" },
  red: { color: "text-sol-red", bg: "bg-sol-red/10", border: "border-sol-red/30" },
  magenta: { color: "text-sol-magenta", bg: "bg-sol-magenta/10", border: "border-sol-magenta/30" },
  cyan: { color: "text-sol-cyan", bg: "bg-sol-cyan/10", border: "border-sol-cyan/30" },
  orange: { color: "text-sol-orange", bg: "bg-sol-orange/10", border: "border-sol-orange/30" },
  violet: { color: "text-sol-violet", bg: "bg-sol-violet/10", border: "border-sol-violet/30" },
  dim: { color: "text-sol-text-dim", bg: "bg-sol-text-dim/10", border: "border-sol-text-dim/30" },
};

export type StatusVisual = {
  icon: ComponentType<{ className?: string }>;
  label: string;
  color: string;
  bg: string;
  border: string;
};

// The "started" run: in_progress then in_review, one progression. A team's
// statuses inside it fill the disc in order, so its second working status
// reads as further along than its first (Linear's graduated circles).
const STARTED: readonly TaskStatusCategory[] = ["in_progress", "in_review"];

/**
 * Disc fill for a started status: its rank across the team's started run,
 * spread over (0, 1). Without the list, a category default — half for
 * in_progress, three quarters for in_review — so lone call sites still shade.
 */
export function statusFill(s: TeamTaskStatus, statuses?: TeamTaskStatus[]): number {
  if (!STARTED.includes(s.category)) return 0;
  const run = statuses
    ? orderedStatuses(statuses).filter((x) => STARTED.includes(x.category))
    : [];
  const i = run.findIndex((x) => x.id === s.id);
  if (i < 0) return s.category === "in_progress" ? 0.5 : 0.75;
  return (i + 1) / (run.length + 1);
}

// One component per (category, fill) so a re-render sees the same element
// type and React keeps the DOM node instead of remounting the svg.
const iconCache = new Map<string, ComponentType<{ className?: string }>>();
function statusIcon(category: TaskStatusCategory, fill: number): ComponentType<{ className?: string }> {
  const key = `${category}:${fill.toFixed(3)}`;
  let Icon = iconCache.get(key);
  if (!Icon) {
    Icon = function StatusIcon({ className }: { className?: string }) {
      return createElement(StatusCircle, { category, progress: fill, className });
    };
    iconCache.set(key, Icon);
  }
  return Icon;
}

/** Glyph from the category + position (shape and fill = meaning), name/color
 *  from the status. Pass the team's list for graduated fills across statuses. */
export function statusVisual(s: TeamTaskStatus, statuses?: TeamTaskStatus[]): StatusVisual {
  const base = TASK_STATUS[s.category];
  const custom = s.color ? STATUS_COLOR_CLASSES[s.color] : undefined;
  return {
    icon: statusIcon(s.category, statusFill(s, statuses)),
    label: s.name,
    color: custom?.color ?? base.color,
    bg: custom?.bg ?? base.bg,
    border: custom?.border ?? base.border,
  };
}

/** Work-first category order (the board's order), keeping the team's own
 *  order within each category (Array.prototype.sort is stable). */
export function orderedStatuses(statuses: TeamTaskStatus[]): TeamTaskStatus[] {
  return [...statuses].sort(
    (a, b) => TASK_STATUS_ORDER.indexOf(a.category) - TASK_STATUS_ORDER.indexOf(b.category),
  );
}

// Pipeline order for kanban columns: not started on the left, started in the
// middle, finished on the right. The list view keeps TASK_STATUS_ORDER (active
// work first); the board reads left to right as a pipeline instead. The shared
// TASK_STATUS_CATEGORIES tuple is already in pipeline order.
const BOARD_CATEGORY_ORDER: readonly TaskStatusCategory[] = TASK_STATUS_CATEGORIES;

/**
 * Kanban column order: pipeline category order, the team's own order within
 * each category, then the user's saved column order (status ids) on top. A
 * status the saved order predates joins its category's section wherever the
 * user put it; only a category with no column yet falls to pipeline position.
 */
export function boardOrderedStatuses(statuses: TeamTaskStatus[], savedOrder?: string[]): TeamTaskStatus[] {
  const pipeIdx = (s: TeamTaskStatus) => BOARD_CATEGORY_ORDER.indexOf(s.category);
  const base = [...statuses].sort((a, b) => pipeIdx(a) - pipeIdx(b));
  if (!savedOrder?.length) return base;
  const byId = new Map(base.map((s) => [s.id, s]));
  const result = savedOrder.map((id) => byId.get(id)).filter((s): s is TeamTaskStatus => !!s);
  const placed = new Set(result.map((s) => s.id));
  for (const s of base) {
    if (placed.has(s.id)) continue;
    const lastKin = result.findLastIndex((r) => r.category === s.category);
    if (lastKin >= 0) {
      result.splice(lastKin + 1, 0, s);
      continue;
    }
    const at = result.findIndex((r) => pipeIdx(r) > pipeIdx(s));
    result.splice(at < 0 ? result.length : at, 0, s);
  }
  return result;
}

/** A team's effective statuses out of the store's teams list. */
export function statusesForTeam(teams: any[], teamId?: string | null): TeamTaskStatus[] {
  if (!teamId) return DEFAULT_TASK_STATUSES;
  const team = (teams || []).find((t: any) => String(t._id) === String(teamId));
  return teamTaskStatuses(team?.task_statuses);
}

/** The active workspace's status list, board-ordered. Personal = defaults. */
export function useTeamTaskStatusList(teamId?: string | null): TeamTaskStatus[] {
  const teams = useInboxStore((s) => s.teams);
  return useMemo(() => orderedStatuses(statusesForTeam(teams, teamId)), [teams, teamId]);
}

/** The status a task renders as. */
export function taskStatusOf(
  task: { status?: string | null; status_id?: string | null },
  statuses: TeamTaskStatus[],
): TeamTaskStatus {
  return resolveTaskStatus(task, statuses);
}

/** Bucket key for kanban columns and status group headers. */
export function taskStatusKey(
  task: { status?: string | null; status_id?: string | null },
  statuses: TeamTaskStatus[],
): string {
  return resolveTaskStatus(task, statuses).id;
}

/**
 * The updateTask fields that move a task to `s`. The category always rides
 * along (it is what the server's indexes and side effects key on); status_id
 * is "" for a category default so the server clears the refinement.
 */
export function statusWriteFields(s: TeamTaskStatus): { status: TaskStatusCategory; status_id: string } {
  return { status: s.category, status_id: s.id === s.category ? "" : s.id };
}

export type StatusOption = {
  key: string;
  label: string;
  icon: StatusVisual["icon"];
  color: string;
  category: TaskStatusCategory;
};

/** Picker options (palette, context menu, dropdowns), board-ordered. */
export function statusEntityOptions(statuses: TeamTaskStatus[]): StatusOption[] {
  return orderedStatuses(statuses).map((s) => {
    const v = statusVisual(s, statuses);
    return { key: s.id, label: v.label, icon: v.icon, color: v.color, category: s.category };
  });
}

/** Find a status by picker key (status id). */
export function statusByKey(statuses: TeamTaskStatus[], key: string): TeamTaskStatus | undefined {
  return statuses.find((s) => s.id === key);
}
