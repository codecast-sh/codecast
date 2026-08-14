"use client";
/**
 * Client side of per-team task statuses (Linear-style; contract in
 * @codecast/shared/tasks/statuses.ts). The store's `teams` list carries each
 * team's `task_statuses`; everything here resolves a task's canonical category
 * plus optional `status_id` into the team's named status, and shapes that list
 * for the surfaces that render or pick statuses (board columns, group headers,
 * palette / context-menu / dropdown options).
 */
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { TASK_STATUS, TASK_STATUS_ORDER } from "../components/TaskStatusBadge";
import {
  DEFAULT_TASK_STATUSES,
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
  icon: (typeof TASK_STATUS)["open"]["icon"];
  label: string;
  color: string;
  bg: string;
  border: string;
};

/** Icon from the category (shape = meaning), name/color from the status. */
export function statusVisual(s: TeamTaskStatus): StatusVisual {
  const base = TASK_STATUS[s.category];
  const custom = s.color ? STATUS_COLOR_CLASSES[s.color] : undefined;
  return {
    icon: base.icon,
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
    const v = statusVisual(s);
    return { key: s.id, label: v.label, icon: v.icon, color: v.color, category: s.category };
  });
}

/** Find a status by picker key (status id). */
export function statusByKey(statuses: TeamTaskStatus[], key: string): TeamTaskStatus | undefined {
  return statuses.find((s) => s.id === key);
}
