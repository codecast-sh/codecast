// What a role looks after, as one model (docs/architecture/org-roles-run-work.md
// R3; initiatives-projects-role-page.md I2). Projects are the unit of a scope:
// each is one card that holds its plans, its open and done tasks and the
// sessions active in it, and a plan is never listed beside its project. Plans
// that sit in no project go in one last group. The hover card and the role page's Scope tab are the same rendering at
// two sizes (components/identity/RoleScopeView), and both paint from this.
//
// Two sources feed it, normalized to one shape: the org tree slice when the
// store holds the role, and the `org.roleCard` answer when it does not (a
// hover on a page that never mounted the tree). Everything counted here is
// derived at build time from the live rows (open tasks for a project, a plan's
// progress, the tasks a role owns), never read off a stored twin, so an
// optimistic edit moves the numbers in the same tick (CLAUDE.md, derived
// fields). Pure: no React, no store.
import type { WorkState } from "@codecast/shared/contracts";
import { projectLeadOf, type LeadRole } from "@codecast/shared/contracts/orgLead";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { computePlanProgress } from "./liveEntities";
import { roleInitiatives, type RoleInitiative } from "./roleInitiatives";
import { HAND_GROUPS } from "./scopePage";
import { parentName } from "../components/org/orgMeta";
import type { OrgRole, OrgTree, StateCounts } from "../components/org/orgTypes";

/** Someone a role reports to, or a role that reports to it. */
export type RoleScopeParty =
  | { kind: "role"; short_id: string; name: string; handle: string; avatar?: string }
  | { kind: "user"; name: string; image?: string };

export type RoleLimits = { hands_per_day: number; wakes_per_day: number; tokens_per_day: number };
export type RoleUse = { day: string; hands: number; wakes: number; tokens: number };

/** The role's own facts, from the tree or from the card. */
export type RoleScopeSource = {
  /** The role row's id: what `tasks.assignee` and `projects.owner_role_id`
   *  name. Null when only a snapshot is known. */
  role_id: string | null;
  short_id: string;
  name: string;
  handle: string;
  whole: boolean;
  projects: { id: string; title: string; short_id?: string | null }[];
  plans: { id: string; title: string; short_id: string }[];
  charter: string;
  reportsTo: RoleScopeParty | null;
  reports: RoleScopeParty[];
  /** Sessions that report to the role, by who acts next; null when unknown. */
  counts: StateCounts | null;
  total: number;
  caps: RoleLimits | null;
  counters: RoleUse | null;
};

const partyOfRole = (r: Pick<OrgRole, "short_id" | "name" | "handle" | "avatar">): RoleScopeParty =>
  ({ kind: "role", short_id: r.short_id, name: r.name, handle: r.handle, avatar: r.avatar });

export function sourceFromTree(tree: OrgTree, role: OrgRole): RoleScopeSource {
  const rt = role.reports_to;
  const parentRole = rt.kind === "role" ? tree.roles.find((r) => r._id === rt.role_id) : undefined;
  const parentUser = rt.kind === "user" ? tree.people.find((p) => p.user_id === rt.user_id) : undefined;
  return {
    role_id: role._id, short_id: role.short_id, name: role.name, handle: role.handle,
    whole: role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0,
    projects: role.scope_names.projects,
    plans: role.scope_names.plans,
    charter: role.charter ?? "",
    reportsTo: parentRole ? partyOfRole(parentRole) : { kind: "user", name: parentName(tree, rt), image: parentUser?.image },
    reports: tree.roles.filter((r) => r.status !== "retired" && r.reports_to.kind === "role" && r.reports_to.role_id === role._id).map(partyOfRole),
    counts: role.counts, total: role.total,
    caps: role.caps ?? null, counters: role.counters ?? null,
  };
}

/** The `org.roleCard` answer (convex/org.ts), as far as this reads it. */
export type RoleCardAnswer = {
  _id: string; short_id: string; name: string; handle: string; charter?: string;
  reports_to: { kind: "user" | "role"; name: string; short_id?: string; avatar?: string } | null;
  scope: { projects: { id: string; title: string; short_id: string | null }[]; plans: { id: string; title: string; short_id: string }[] };
  caps: RoleLimits | null; counters: RoleUse | null;
};

export function sourceFromCard(card: RoleCardAnswer): RoleScopeSource {
  const p = card.reports_to;
  return {
    role_id: card._id, short_id: card.short_id, name: card.name, handle: card.handle,
    whole: card.scope.projects.length === 0 && card.scope.plans.length === 0,
    projects: card.scope.projects, plans: card.scope.plans,
    charter: card.charter ?? "",
    // The card names a parent role without its handle: the name stands in.
    reportsTo: !p ? null : p.kind === "role" && p.short_id ? { kind: "role", short_id: p.short_id, name: p.name, handle: "", avatar: p.avatar } : { kind: "user", name: p.name, image: p.avatar },
    reports: [], counts: null, total: 0,
    caps: card.caps, counters: card.counters,
  };
}

// ------------------------------------------------------------------ the model

type ProjectRow = { _id: string; title: string; short_id?: string; status?: string; owner_role_id?: string };
type PlanRow = { _id: string; title: string; short_id?: string; status: string; project_id?: string | null };
type TaskRow = { _id: string; status?: string; project_id?: string | null; plan_id?: string | null; assignee?: string | null };

/** A session that reports to the role, and the task it is bound to, if any. */
type SessionRow = { state: WorkState; task_id: string | null };

export type RoleScopeRows = { projects: ProjectRow[]; plans: PlanRow[]; tasks: TaskRow[]; roles: LeadRole[]; sessions?: SessionRow[]; initiatives?: readonly InitiativeRow[] };

export type ScopePlan = { id: string; ref: string; title: string; status: string | null; done: number; total: number };
export type ScopeSessionGroup = { state: WorkState; label: string; count: number };
export type ScopeProject = {
  id: string; ref: string; title: string; status: string | null;
  open: number; done: number; leads: boolean;
  /** The scope names plans of this project, not the project itself. */
  partial: boolean;
  plans: ScopePlan[];
  /** The role's sessions bound to a task in this project, by who acts next. */
  sessions: ScopeSessionGroup[];
};
export type ScopeOwned = { status: string; label: string; count: number };

export type RoleScopeModel = {
  whole: boolean;
  /** The goals this work serves (initiatives-projects-role-page.md I1): the
   *  ones the role drives first, then the ones its projects contribute to. */
  initiatives: RoleInitiative[];
  projects: ScopeProject[];
  /** Plans in scope that sit in no project: the last card, with the gesture that files them. */
  loosePlans: ScopePlan[];
  sessions: { groups: ScopeSessionGroup[]; total: number; waiting: number } | null;
  charter: { sentence: string; paragraph: string; more: boolean };
  reportsTo: RoleScopeParty | null;
  reports: RoleScopeParty[];
  owned: { open: number; byStatus: ScopeOwned[] };
  limit: string | null;
};

const CLOSED = new Set(["done", "dropped"]);
const isOpenTask = (t: TaskRow) => !CLOSED.has(t.status ?? "open");

/** The order a role's own tasks read in: what moves first, then what waits. */
const OWNED_ORDER: [string, string][] = [["in_progress", "in progress"], ["in_review", "in review"], ["open", "open"], ["backlog", "backlog"], ["done", "done"]];

/** Who acts next, in a person's words rather than the state's name. */
const SESSION_WORDS: Partial<Record<WorkState, string>> = { needs_input: "waiting on a person", working: "working", done: "finished", dormant: "parked", idle: "idle" };

/** Counts by state as the groups a person reads, in the inbox's order. */
function groupWords(counts: Map<WorkState, number> | undefined): ScopeSessionGroup[] {
  if (!counts) return [];
  return HAND_GROUPS.map((g) => ({ state: g.state, label: SESSION_WORDS[g.state] ?? g.label.toLowerCase(), count: counts.get(g.state) ?? 0 })).filter((g) => g.count > 0);
}

/** The first paragraph, minus a leading heading, and its first sentence. */
export function charterLead(text: string): RoleScopeModel["charter"] {
  const body = text.trim().replace(/^#+[^\n]*\n+/, "");
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const paragraph = paragraphs[0] ?? "";
  const stop = paragraph.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? paragraph : paragraph.slice(0, stop + 1);
  return { sentence, paragraph, more: paragraphs.length > 1 };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Today's use against the daily limit, in the staffing pane's words: a
 *  limit, wakes and sessions, never "caps" or "hands". */
export function dailyLimitLine(caps: RoleLimits | null, counters: RoleUse | null, today: string): string | null {
  if (!caps) return null;
  const used = counters && counters.day === today ? counters : { wakes: 0, hands: 0 };
  // A limit of zero is a rule, not a count: "0 of 0" says nothing to a person.
  const starts = caps.hands_per_day > 0 ? `started ${used.hands} of ${plural(caps.hands_per_day, "session")}` : "may not start sessions";
  return `woke ${used.wakes} of ${plural(caps.wakes_per_day, "time")} today · ${starts}`;
}

export function buildRoleScope(source: RoleScopeSource, rows: RoleScopeRows, today: string): RoleScopeModel {
  const projectById = new Map(rows.projects.map((p) => [p._id, p]));
  const planById = new Map(rows.plans.map((p) => [p._id, p]));
  // An empty scope is the whole workspace (scopes-and-feed.md F1): every
  // project the store holds for it.
  const projectRefs = source.whole ? rows.projects.map((p) => ({ id: p._id, title: p.title, short_id: p.short_id })) : source.projects;
  const inScope = new Set(projectRefs.map((p) => p.id));

  // A task with no project of its own counts under its plan's project, so a
  // plan filed under a project brings its work with it in the same tick.
  const projectOfTask = (t: TaskRow): string | null => t.project_id ?? (t.plan_id ? planById.get(t.plan_id)?.project_id ?? null : null);
  const openBy = new Map<string, number>();
  const doneBy = new Map<string, number>();
  const byPlan = new Map<string, TaskRow[]>();
  const ownedCounts = new Map<string, number>();
  const taskProject = new Map<string, string>();
  for (const t of rows.tasks) {
    const pid = projectOfTask(t);
    if (pid) {
      taskProject.set(t._id, pid);
      if (isOpenTask(t)) openBy.set(pid, (openBy.get(pid) ?? 0) + 1);
      else if (t.status === "done") doneBy.set(pid, (doneBy.get(pid) ?? 0) + 1);
    }
    if (t.plan_id) { const list = byPlan.get(t.plan_id); if (list) list.push(t); else byPlan.set(t.plan_id, [t]); }
    if (source.role_id && t.assignee === source.role_id) ownedCounts.set(t.status ?? "open", (ownedCounts.get(t.status ?? "open") ?? 0) + 1);
  }

  // The plans in scope: the ones named, and the open plans of a project in scope (F1).
  const planRefs = new Map(source.plans.map((p) => [p.id, p]));
  for (const p of rows.plans) if (!planRefs.has(p._id) && p.project_id && inScope.has(p.project_id) && (p.status === "active" || p.status === "draft")) planRefs.set(p._id, { id: p._id, title: p.title, short_id: p.short_id ?? p._id });
  const plansBy = new Map<string, ScopePlan[]>();
  const loosePlans: ScopePlan[] = [];
  for (const ref of planRefs.values()) {
    const row = planById.get(ref.id);
    const pr = computePlanProgress(byPlan.get(ref.id));
    const plan: ScopePlan = { id: ref.id, ref: row?.short_id ?? ref.short_id, title: row?.title ?? ref.title, status: row?.status ?? null, done: pr.done, total: pr.total };
    const home = row?.project_id && (inScope.has(row.project_id) || projectById.has(row.project_id)) ? row.project_id : null;
    if (!home) loosePlans.push(plan);
    else { const list = plansBy.get(home); if (list) list.push(plan); else plansBy.set(home, [plan]); }
  }
  const planOrder = (a: ScopePlan, b: ScopePlan) => Number(b.status === "active") - Number(a.status === "active") || a.title.localeCompare(b.title);

  const sessionsBy = new Map<string, Map<WorkState, number>>();
  for (const s of rows.sessions ?? []) {
    const pid = s.task_id ? taskProject.get(s.task_id) : undefined;
    if (!pid) continue;
    const counts = sessionsBy.get(pid) ?? new Map<WorkState, number>();
    counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
    sessionsBy.set(pid, counts);
  }

  // A project in scope, then a project that is only here through a plan the scope names.
  const partialRefs = Array.from(plansBy.keys()).filter((id) => !inScope.has(id)).map((id) => ({ id, title: projectById.get(id)!.title, short_id: projectById.get(id)!.short_id }));
  const projects: ScopeProject[] = [...projectRefs, ...partialRefs].map((ref) => {
    const row = projectById.get(ref.id);
    const lead = projectLeadOf(row ?? { _id: ref.id }, rows.roles);
    return {
      id: ref.id, ref: row?.short_id ?? ref.short_id ?? ref.id, title: row?.title ?? ref.title,
      status: row?.status ?? null, open: openBy.get(ref.id) ?? 0, done: doneBy.get(ref.id) ?? 0,
      leads: !!source.role_id && lead.kind === "lead" && String(lead.role._id) === source.role_id,
      partial: !inScope.has(ref.id),
      plans: (plansBy.get(ref.id) ?? []).sort(planOrder),
      sessions: groupWords(sessionsBy.get(ref.id)),
    };
  }).sort((a, b) => Number(a.partial) - Number(b.partial) || Number(b.leads) - Number(a.leads) || b.open - a.open || a.title.localeCompare(b.title));
  loosePlans.sort(planOrder);

  const sessions = source.counts ? {
    groups: groupWords(new Map(Object.entries(source.counts) as [WorkState, number][])),
    total: source.total,
    waiting: source.counts.needs_input ?? 0,
  } : null;

  const byStatus = OWNED_ORDER.map(([status, label]) => ({ status, label, count: ownedCounts.get(status) ?? 0 })).filter((s) => s.count > 0);
  return {
    whole: source.whole, projects, loosePlans, sessions,
    initiatives: source.role_id ? roleInitiatives(source.role_id, Array.from(inScope), rows.initiatives ?? []) : [],
    charter: charterLead(source.charter),
    reportsTo: source.reportsTo, reports: source.reports,
    owned: { open: byStatus.filter((s) => !CLOSED.has(s.status)).reduce((n, s) => n + s.count, 0), byStatus },
    limit: dailyLimitLine(source.caps, source.counters, today),
  };
}

/** A project's one line state: "14 open tasks · 3 done", "paused · nothing open". */
export function projectStateLine(p: Pick<ScopeProject, "status" | "open" | "done">): string {
  const parts: string[] = [];
  if (p.status && p.status !== "active") parts.push(p.status);
  parts.push(p.open > 0 ? plural(p.open, "open task") : "nothing open");
  if (p.done > 0) parts.push(`${p.done.toLocaleString("en-US")} done`);
  return parts.join(" · ");
}

/** The sessions in a project: "1 waiting on a person · 2 working". */
export function groupsLine(groups: ScopeSessionGroup[]): string {
  return groups.map((g) => `${g.count} ${g.label}`).join(" · ");
}

/** A plan's one line state: "3 of 8 done", "draft · no tasks yet". */
export function planStateLine(p: ScopePlan): string {
  const parts: string[] = [];
  if (p.status && p.status !== "active") parts.push(p.status);
  parts.push(p.total > 0 ? `${p.done} of ${p.total} done` : "no tasks yet");
  return parts.join(" · ");
}

/** The sessions in one line: "2 waiting on a person · 3 working". */
export function sessionsLine(s: NonNullable<RoleScopeModel["sessions"]>): string {
  return s.groups.length === 0 ? "no sessions yet" : groupsLine(s.groups);
}
