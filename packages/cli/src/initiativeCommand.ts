// The pure half of `cast initiative` (initiatives-projects-role-page.md I1):
// reading a status or a health the way a person types one, the lines `ls` and
// `show` print, and the one sentence that says what happened to the owner
// role's scope. The network calls and the exits live in index.ts.

import { targetDayOf } from "@codecast/shared/time";
import {
  INITIATIVE_HEALTH_LABEL,
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_LABEL,
  INITIATIVE_UPDATE_HEALTHS,
  type InitiativeHealth,
  type InitiativeStatus,
  type InitiativeUpdateHealth,
} from "@codecast/shared/contracts/initiative";

type Palette = Record<"green" | "yellow" | "red" | "cyan" | "dim" | "bold" | "reset", string>;

export const INITIATIVE_STATUS_ICONS: Record<InitiativeStatus, string> = {
  proposed: "○",
  planned: "◌",
  active: "◉",
  completed: "●",
  cancelled: "⊘",
};

// "on track", "on-track", "On_Track" and "ontrack" all mean on_track.
const squash = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, "");

function oneOf<T extends string>(values: readonly T[], text: string): T | null {
  return values.find((v) => squash(v) === squash(text)) ?? null;
}

export const parseInitiativeHealth = (text: string): InitiativeUpdateHealth | null => oneOf(INITIATIVE_UPDATE_HEALTHS, text);
export const parseInitiativeStatus = (text: string): InitiativeStatus | null => oneOf(INITIATIVE_STATUSES, text);

const healthColor = (c: Palette, health: InitiativeHealth) =>
  health === "on_track" ? c.green : health === "at_risk" ? c.yellow : health === "off_track" ? c.red : c.dim;

// A moment (an update's `at`) prints as the person's own day. A target day
// prints through the shared pair that stored it (shared/time targetDayOf).
export function dayText(ms?: number): string | undefined {
  if (!ms) return undefined;
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function healthText(c: Palette, health: InitiativeHealth, at?: number): string {
  const when = at ? ` ${c.dim}(${dayText(at)})${c.reset}` : "";
  return `${healthColor(c, health)}${INITIATIVE_HEALTH_LABEL[health]}${c.reset}${when}`;
}

export function progressText(counts?: { total: number; done: number }): string {
  if (!counts?.total) return "no tasks";
  return `${counts.done}/${counts.total} done (${Math.round((counts.done / counts.total) * 100)}%)`;
}

/** One row of `cast initiative ls`. */
export function initiativeLine(c: Palette, row: any): string {
  const facts = [
    INITIATIVE_STATUS_LABEL[row.status as InitiativeStatus] ?? row.status,
    row.owner_label ?? `${c.yellow}no owner${c.reset}${c.dim}`,
    `${row.projects?.length ?? row.project_ids?.length ?? 0} projects`,
    progressText(row.task_counts),
    row.target_date ? `target ${targetDayOf(row.target_date)}` : null,
  ].filter(Boolean);
  const icon = INITIATIVE_STATUS_ICONS[row.status as InitiativeStatus] ?? "?";
  return `  ${icon} ${c.cyan}${row.short_id}${c.reset} ${c.bold}${row.title}${c.reset} ${healthText(c, row.health, row.health_at)} ${c.dim}${facts.join(" | ")}${c.reset}`;
}

/**
 * What happened to the owner role's scope, in one sentence, or null when
 * nothing did. `scope` is performCoverProjects' answer as the write returns it.
 */
export function scopeSentence(owner: string | undefined, scope: any, titleOf: (projectId: string) => string): string | null {
  if (!scope) return null;
  const who = owner ?? "The owner role";
  const names = (ids: string[]) => ids.map(titleOf).join(", ");
  const parts: string[] = [];
  if (scope.added?.length) parts.push(`${who} now has ${names(scope.added)} in its scope.`);
  const reasons: Record<string, string> = {
    not_admin: "only an admin of the role may change its scope",
    human_only: "a scope changes from the role page in the browser, never from a token call",
    outside_parent: "it is outside the scope of the role it reports to",
    whole_workspace: "the role already looks after the whole workspace",
  };
  const byReason = new Map<string, string[]>();
  for (const s of scope.skipped ?? []) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.project_id]);
  for (const [reason, ids] of byReason) {
    if (reason === "whole_workspace") continue; // nothing is missing from a whole workspace
    parts.push(`${names(ids)} was not added to its scope: ${reasons[reason] ?? reason}.`);
  }
  if (scope.took_over) parts.push(scope.took_over);
  return parts.length ? parts.join(" ") : null;
}
