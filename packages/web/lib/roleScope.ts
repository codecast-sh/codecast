// What a role looks after, as one model (docs/architecture/org-roles-run-work.md
// R3). The hover card and the role page's Scope tab are the same rendering at
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
import { computePlanProgress } from "./liveEntities";
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

export type RoleScopeRows = { projects: ProjectRow[]; plans: PlanRow[]; tasks: TaskRow[]; roles: LeadRole[] };

export type ScopeProject = { id: string; ref: string; title: string; status: string | null; open: number; leads: boolean };
export type ScopePlan = { id: string; ref: string; title: string; status: string | null; done: number; total: number };
export type ScopeSessionGroup = { state: WorkState; label: string; count: number };
export type ScopeOwned = { status: string; label: string; count: number };

export type RoleScopeModel = {
  whole: boolean;
  projects: ScopeProject[];
  plans: ScopePlan[];
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
  return `woke ${used.wakes} of ${plural(caps.wakes_per_day, "time")} today · started ${used.hands} of ${plural(caps.hands_per_day, "session")}`;
}

export function buildRoleScope(source: RoleScopeSource, rows: RoleScopeRows, today: string): RoleScopeModel {
  const projectById = new Map(rows.projects.map((p) => [p._id, p]));
  const planById = new Map(rows.plans.map((p) => [p._id, p]));
  // An empty scope is the whole workspace (scopes-and-feed.md F1): every
  // project the store holds for it, active ones first in the list below.
  const projectRefs = source.whole ? rows.projects.map((p) => ({ id: p._id, title: p.title, short_id: p.short_id })) : source.projects;
  const projectIds = new Set(projectRefs.map((p) => p.id));

  const openByProject = new Map<string, number>();
  const byPlan = new Map<string, TaskRow[]>();
  const ownedCounts = new Map<string, number>();
  for (const t of rows.tasks) {
    if (t.project_id && isOpenTask(t)) openByProject.set(t.project_id, (openByProject.get(t.project_id) ?? 0) + 1);
    if (t.plan_id) { const list = byPlan.get(t.plan_id); if (list) list.push(t); else byPlan.set(t.plan_id, [t]); }
    if (source.role_id && t.assignee === source.role_id) ownedCounts.set(t.status ?? "open", (ownedCounts.get(t.status ?? "open") ?? 0) + 1);
  }

  const projects: ScopeProject[] = projectRefs.map((ref) => {
    const row = projectById.get(ref.id);
    const lead = projectLeadOf(row ?? { _id: ref.id }, rows.roles);
    return {
      id: ref.id, ref: row?.short_id ?? ref.short_id ?? ref.id, title: row?.title ?? ref.title,
      status: row?.status ?? null, open: openByProject.get(ref.id) ?? 0,
      leads: !!source.role_id && lead.kind === "lead" && String(lead.role._id) === source.role_id,
    };
  }).sort((a, b) => Number(b.leads) - Number(a.leads) || b.open - a.open || a.title.localeCompare(b.title));

  // A plan of a project in scope is in scope (F1), beside the plans named.
  const planRefs = new Map(source.plans.map((p) => [p.id, p]));
  for (const p of rows.plans) if (!planRefs.has(p._id) && p.project_id && projectIds.has(p.project_id) && (p.status === "active" || p.status === "draft")) planRefs.set(p._id, { id: p._id, title: p.title, short_id: p.short_id ?? p._id });
  const plans: ScopePlan[] = Array.from(planRefs.values()).map((ref) => {
    const row = planById.get(ref.id);
    const pr = computePlanProgress(byPlan.get(ref.id));
    return { id: ref.id, ref: row?.short_id ?? ref.short_id, title: row?.title ?? ref.title, status: row?.status ?? null, done: pr.done, total: pr.total };
  }).sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || a.title.localeCompare(b.title));

  const sessions = source.counts ? {
    groups: HAND_GROUPS.map((g) => ({ state: g.state, label: SESSION_WORDS[g.state] ?? g.label.toLowerCase(), count: source.counts![g.state] ?? 0 })).filter((g) => g.count > 0),
    total: source.total,
    waiting: source.counts.needs_input ?? 0,
  } : null;

  const byStatus = OWNED_ORDER.map(([status, label]) => ({ status, label, count: ownedCounts.get(status) ?? 0 })).filter((s) => s.count > 0);
  return {
    whole: source.whole, projects, plans, sessions,
    charter: charterLead(source.charter),
    reportsTo: source.reportsTo, reports: source.reports,
    owned: { open: byStatus.filter((s) => !CLOSED.has(s.status)).reduce((n, s) => n + s.count, 0), byStatus },
    limit: dailyLimitLine(source.caps, source.counters, today),
  };
}

/** A project's one line state: "14 open tasks · lead", "paused · nothing open". */
export function projectStateLine(p: ScopeProject): string {
  const parts: string[] = [];
  if (p.status && p.status !== "active") parts.push(p.status);
  parts.push(p.open > 0 ? plural(p.open, "open task") : "nothing open");
  if (p.leads) parts.push("lead");
  return parts.join(" · ");
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
  return s.groups.length === 0 ? "no sessions yet" : s.groups.map((g) => `${g.count} ${g.label}`).join(" · ");
}
