// The facts a line reads, joined once (cohesive build spec §6). Pure, so the
// company document's model, a sheet's Carried by and a hover card's summary
// all count a project's work, its sessions and its lead by the same rule.
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { projectTaskCounts } from "@codecast/shared/tasks";
import type { BoardTask } from "../../../lib/initiatives";
import { sessionsUnder, type GoalProject } from "../goalsLayout";
import { countStates, type OrgRole, type OrgTree, type StateCounts } from "../orgTypes";

/** What a project line reads off a project row. */
export type LineProjectRow = GoalProject & { color?: string; target_date?: number; risks?: string[] };

export type LineProject = {
  id: string;
  title: string;
  short_id?: string;
  status?: string;
  color?: string;
  target_date?: number;
  risks?: string[];
  /** Tasks open and done by the board's rule; "counting" while the task store fills; null when it has none. */
  counts: { open: number; done: number } | "counting" | null;
  /** Sessions under the roles whose area holds it, by state; null when the tree carries none. */
  sessions: StateCounts | null;
  /** The role the project names or whose scope lists it. */
  lead: OrgRole | null;
};

/** The lead a project names or whose scope lists it. A whole workspace role
 *  covers every project by the rule, which says nothing about this one, so it
 *  is no lead here (the map's Goals lens reads it the same way). */
export function namedLead(project: GoalProject | undefined, roles: readonly OrgRole[]): OrgRole | null {
  const lead = project ? projectLeadOf(project, roles) : null;
  return lead?.kind === "lead" && lead.by !== "workspace" ? lead.role : null;
}

export type LineContext = {
  tree: OrgTree | null;
  /** The live roles, in the tree's order. */
  roles: readonly OrgRole[];
  /** The workspace's tasks, counted by the board's one rule (projectTaskCounts). */
  tasks: readonly BoardTask[];
  /** False while the task store is still filling. */
  tasksCounted?: boolean;
};

/** A project row's line facts: the counts its own board shows, what is moving under it, and its lead. */
export function lineProjectOf(row: LineProjectRow, ctx: LineContext): LineProject {
  const n = projectTaskCounts(ctx.tasks, [row._id]);
  const sessions = ctx.tree ? sessionsUnder(ctx.tree, [row._id]) : [];
  return {
    id: row._id, title: row.title,
    ...(row.short_id ? { short_id: row.short_id } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.color ? { color: row.color } : {}),
    ...(row.target_date ? { target_date: row.target_date } : {}),
    ...(row.risks?.length ? { risks: row.risks } : {}),
    counts: ctx.tasksCounted === false ? "counting" : n.total > 0 ? { open: n.total - n.done, done: n.done } : null,
    sessions: sessions.length ? countStates([...sessions]) : null,
    lead: namedLead(row, ctx.roles),
  };
}

/** The class a container wears for its lines to answer to its width. */
export const LINE_SCOPE = "ol-scope";
/** A container whose lines are the compact grid: title, owner, state. */
export const LINE_COMPACT = "ol-compact";
