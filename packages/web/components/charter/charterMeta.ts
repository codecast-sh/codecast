// A charter is the direction a project or plan gives the roles that own it
// (docs/architecture/org-staffing.md S7): the goal, how success is measured,
// where it sits in the priority order, which role owns it, what it is not, and
// what could sink it. The fields ride on the `projects` and `plans` rows the
// store already syncs; this module is the one definition of the field set,
// the priority palette and the role lookups the block, the list rows and the
// org scope panel share.
import type { OrgRole, OrgTree } from "../org/orgTypes";
import { CHIEF_OF_STAFF_HANDLE } from "../org/orgStaffingTypes";
import { cleanBudget, type CharterBudget } from "@codecast/convex/convex/lib/charterBudget";

export { cleanBudget, type CharterBudget };

export type CharterPriority = "p0" | "p1" | "p2" | "p3";

export const CHARTER_PRIORITIES: CharterPriority[] = ["p0", "p1", "p2", "p3"];

/** The charter's own four step scale: p0 red, p1 amber, p2 blue, p3 grey.
 *  Task priority (urgent/high/medium/low, lib/entityDisplay.ts) is a different
 *  vocabulary on a different object and keeps its own palette. `color` is a
 *  CSS token so the pill follows the theme. */
export const PRIORITY_META: Record<CharterPriority, { label: string; color: string; hint: string }> = {
  p0: { label: "P0", color: "var(--sol-red)", hint: "Drop everything: a promise to a customer or the company's survival" },
  p1: { label: "P1", color: "var(--sol-orange)", hint: "This quarter's bet: staffed first, reviewed every week" },
  p2: { label: "P2", color: "var(--sol-blue)", hint: "Important, scheduled after the P1 work" },
  p3: { label: "P3", color: "var(--sol-text-dim)", hint: "Nice to have: picked up when a hand is free" },
};

export function isCharterPriority(v: unknown): v is CharterPriority {
  return typeof v === "string" && (CHARTER_PRIORITIES as string[]).includes(v);
}

/** The fields as the rows carry them. A plan has no risks and no budget. */
export type CharterFields = {
  goal?: string;
  success_metrics?: string[];
  priority?: CharterPriority;
  owner_role_id?: string;
  non_goals?: string[];
  risks?: string[];
  budget?: CharterBudget;
};

/** A write. `null` clears a scalar (the dispatch drops the field server side);
 *  an empty array is a value: the person removed every item. */
export type CharterPatch = {
  goal?: string;
  success_metrics?: string[];
  priority?: CharterPriority | null;
  owner_role_id?: string | null;
  non_goals?: string[];
  risks?: string[];
  budget?: CharterBudget | null;
};

export type CharterKind = "project" | "plan";

export const CHARTER_KEYS: Record<CharterKind, (keyof CharterFields)[]> = {
  project: ["goal", "success_metrics", "priority", "owner_role_id", "non_goals", "risks", "budget"],
  plan: ["goal", "success_metrics", "priority", "owner_role_id", "non_goals"],
};

/** Pick the charter off a row, the plan subset for plans. */
export function charterOf(row: Record<string, unknown> | null | undefined, kind: CharterKind): CharterFields {
  const out: CharterFields = {};
  if (!row) return out;
  for (const key of CHARTER_KEYS[kind]) {
    const v = row[key];
    if (v !== undefined && v !== null) (out as any)[key] = v;
  }
  return out;
}

/** Is there anything to show? A whitespace goal or an empty list is nothing. */
export function hasCharter(c: CharterFields): boolean {
  if (c.goal?.trim()) return true;
  if (c.priority) return true;
  if (c.owner_role_id) return true;
  for (const list of [c.success_metrics, c.non_goals, c.risks]) if (list && list.length > 0) return true;
  if (c.budget && (c.budget.tokens_per_day || c.budget.hands_per_day)) return true;
  return false;
}

/** The org page with the staffing composer prefilled (org-staffing.md S5):
 *  the empty state's ask to the chief of staff. */
export function composeCharterHref(title: string): string {
  return `/org?compose=${encodeURIComponent(`draft a charter for ${title}`)}`;
}

export function chiefOfStaffOf(tree: OrgTree | null | undefined): OrgRole | null {
  return tree?.roles.find((r) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status !== "retired") ?? null;
}

/** The live role that owns the row. A retired seat is no owner: the server
 *  refuses to set one (resolveOwnerRole) and the chip falls to "No owner" so
 *  the person is nudged to reassign, instead of linking to a seat that no
 *  longer exists. */
export function ownerRoleOf(tree: OrgTree | null | undefined, ownerRoleId: string | null | undefined): OrgRole | null {
  if (!tree || !ownerRoleId) return null;
  const role = tree.roles.find((r) => r._id === ownerRoleId);
  return role && role.status !== "retired" ? role : null;
}

/** The roles a project or plan can be owned by: live ones, the chief of staff
 *  excluded (it proposes, it never owns a line). */
export function ownerCandidates(tree: OrgTree | null | undefined): OrgRole[] {
  return (tree?.roles ?? []).filter((r) => r.status !== "retired" && r.handle !== CHIEF_OF_STAFF_HANDLE);
}

export function roleHref(role: Pick<OrgRole, "short_id">): string {
  return `/org/${role.short_id}`;
}

/** "400k", "1.2M": the budget line reads at a glance. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZero(n / 1_000)}k`;
  return String(n);
}

/** The inverse for the inline edit: "400k", "1.2M", "400000", "400,000". */
export function parseTokens(s: string): number | null {
  const m = s.trim().toLowerCase().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function trimZero(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
