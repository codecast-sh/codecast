// The company as one document
// (docs/architecture/initiatives-projects-role-page.md I5 "Where it shows").
// Pure: the org tree, the workspace's initiatives and projects, the roster and
// the open proposals' changes in; the document's outline out, in reading
// order: the company, its goals with what carries each, the projects no goal
// carries, then the roles and the people.
//
// The goal outline is `goalsPlan`, the reading the chart's Goals lens draws,
// so the document and the chart place every goal and every proposed change
// the same way. Each project is listed once, under the goal nearest the work
// (`projectRows`), and named as a reference on the others.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { ORG_GOAL_KINDS, type OrgChangeKind } from "@codecast/shared/contracts/orgProposal";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { goalsPlan, projectRows, type GoalGhost, type GoalOwner, type GoalProject, type PlanGoal, type PlanProject } from "../org/goalsLayout";
import { proposalChangeRows, type ProposalTreeRow } from "../org/proposalTree";
import { rolesInTreeOrder } from "../org/staffingModel";
import type { OrgProposalChange } from "../org/orgStaffingTypes";
import type { OrgRole, OrgTree } from "../org/orgTypes";

/** What the document reads off a project row. */
export type CompanyProject = GoalProject & { updated_at?: number; task_counts?: { total: number; done: number; in_progress: number } };
/** What it reads off a roster member, when the org tree has not arrived. */
export type CompanyMember = { _id: string; name?: string; image?: string; github_avatar_url?: string; github_username?: string; is_bot?: boolean };

export type CompanyInput = {
  tree: OrgTree | null;
  /** The team's name, for a workspace whose tree has not arrived. */
  workspaceName?: string | null;
  initiatives: readonly InitiativeRow[];
  projects: readonly CompanyProject[];
  roster?: readonly CompanyMember[];
  /** The changes of every open proposal of this workspace. */
  changes?: readonly OrgProposalChange[];
};

/** One proposed change as the document draws it: the row the proposal card
 *  draws, the proposal it belongs to (a verdict names what that proposal
 *  showed), and what a failed apply said. */
export type DocChange = { row: ProposalTreeRow; proposal_id: string; note?: string };

export type DocProject = {
  id: string;
  title: string;
  short_id?: string;
  status?: string;
  /** The project's own last change: its latest activity. */
  updated_at?: number;
  /** Tasks open and done, when the store counted any. */
  counts: { open: number; done: number } | null;
  /** The row is a proposal's: a project a change adds, or one a proposed goal would carry. */
  ghost?: GoalGhost;
  /** Not under a goal today, and a proposal would put it under this one. */
  proposedUnder?: string;
};

export type DocGoal = {
  id: string;
  title: string;
  short_id?: string;
  /** The live row; absent on a goal a proposal sets. */
  row?: InitiativeRow;
  description?: string;
  /** 1 for a top level goal, 2 for a goal that feeds one. */
  depth: number;
  /** Who would own a goal that has no row yet. */
  owner: GoalOwner | null;
  /** The change that sets this goal, when it is proposed and not yet in the store. */
  proposed?: DocChange;
  /** A goal a change names that nothing live or proposed answers to. */
  unknown: boolean;
  /** Every other change on the goal: its place, its numbers, its owner, its projects. */
  changes: DocChange[];
  projects: DocProject[];
  /** Projects it carries that are listed under another goal. */
  refs: { project: DocProject; under: string }[];
  goals: DocGoal[];
};

export type DocRef = { id: string; short_id?: string; title: string };
export type DocRole = {
  role: OrgRole;
  /** The charter's first sentence. */
  charter: string | null;
  /** Who it reports to, by name. */
  reportsTo: string | null;
  /** The projects it leads by name or by scope. */
  leads: DocRef[];
  goals: DocRef[];
  changes: DocChange[];
};
export type DocPerson = {
  id: string;
  name: string;
  image?: string;
  me: boolean;
  /** Their profile's address, when the roster knows it. */
  username?: string;
  /** The roles that report to them. */
  roles: OrgRole[];
  goals: DocRef[];
};

export type CompanyDoc = {
  name: string;
  /** Why each top level goal matters, in the goals' order. */
  purpose: string[];
  tally: { goals: number; projects: number; people: number; roles: number };
  goals: DocGoal[];
  unfiled: DocProject[];
  roles: DocRole[];
  people: DocPerson[];
  /** Proposed changes to roles and records that sit on no live role: a new role, a record to close. */
  staffing: DocChange[];
  /** How many drawn changes still wait for a verdict. */
  waiting: number;
};

const GOAL_KINDS = new Set<OrgChangeKind>(ORG_GOAL_KINDS);
/** What a proposal still draws: applied changes are in the store, skipped ones are not coming. */
const DRAWN = new Set(["proposed", "failed", "accepted"]);
const NO_TREE: OrgTree = { workspace: { kind: "user", id: "", name: "" }, people: [], roles: [], anchors: [], generated_at: 0 };

/** Up to the first end of sentence, so "3.5 million" does not end one. */
export function firstSentence(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).replace(/\s+/g, " ").trim();
}

const refOf = (g: Pick<InitiativeRow, "_id" | "short_id" | "title">): DocRef => ({ id: g._id, short_id: g.short_id || undefined, title: g.title });

export function companyDoc(input: CompanyInput): CompanyDoc {
  const { initiatives, projects } = input;
  const tree = input.tree ?? NO_TREE;
  // Without the tree a change has no faces and no place: the plain outline.
  const changes = input.tree ? input.changes ?? [] : [];
  const { goals: plan, changeGoal } = goalsPlan({ tree, initiatives, projects, changes });

  // The outline: top level goals in the plan's order, each followed by what
  // feeds it. A cycle in parents draws a goal once.
  const kids = new Map<string | null, PlanGoal[]>();
  for (const g of plan) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g]);
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order);
  const outline: { id: string; depth: number; goal: PlanGoal }[] = [];
  const under = new Map<string | null, PlanGoal[]>();
  const seen = new Set<string>();
  const walk = (g: PlanGoal, parent: string | null, depth: number) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    outline.push({ id: g.id, depth, goal: g });
    under.set(parent, [...(under.get(parent) ?? []), g]);
    for (const k of kids.get(g.id) ?? []) walk(k, g.id, depth + 1);
  };
  for (const g of kids.get(null) ?? []) walk(g, null, 1);
  const placed = projectRows(outline);

  // The proposal's rows, each on the goal, the role or the person it changes.
  const changeById = new Map(changes.map((c) => [c._id, c]));
  const rows = proposalChangeRows(input.tree, changes, { goals: initiatives, projects: projects.map((p) => ({ id: p._id, title: p.title, short_id: p.short_id })) }).filter((r) => DRAWN.has(r.status));
  const docChange = (row: ProposalTreeRow): DocChange => {
    const c = changeById.get(row.change_id);
    return { row, proposal_id: c?.proposal_id ?? "", ...(row.status === "failed" && c?.applied_note ? { note: c.applied_note } : {}) };
  };
  const onGoal = new Map<string, DocChange[]>();
  const onRole = new Map<string, DocChange[]>();
  const staffing: DocChange[] = [];
  const liveRoles = rolesInTreeOrder(input.tree);
  const liveRoleIds = new Set(liveRoles.map((r) => r._id));
  for (const row of rows) {
    const change = docChange(row);
    if (GOAL_KINDS.has(row.kind)) {
      const goalId = changeGoal[row.change_id];
      if (goalId) onGoal.set(goalId, [...(onGoal.get(goalId) ?? []), change]);
    } else if (row.node.kind === "role" && liveRoleIds.has(row.node.id)) {
      onRole.set(row.node.id, [...(onRole.get(row.node.id) ?? []), change]);
    } else {
      staffing.push(change);
    }
  }

  const projectById = new Map(projects.map((p) => [p._id, p]));
  const docProject = (p: Pick<PlanProject, "id" | "title" | "short_id" | "status" | "ghost">): DocProject => {
    const row = projectById.get(p.id);
    const counts = row?.task_counts && row.task_counts.total > 0 ? { open: row.task_counts.total - row.task_counts.done, done: row.task_counts.done } : null;
    return { id: p.id, title: p.title, short_id: p.short_id ?? row?.short_id, status: p.status ?? row?.status, updated_at: row?.updated_at || undefined, counts, ...(p.ghost ? { ghost: p.ghost } : {}) };
  };
  const docGoal = (g: PlanGoal, depth: number): DocGoal => {
    const mine = onGoal.get(g.id) ?? [];
    const proposed = g.row ? undefined : mine.find((c) => c.row.kind === "initiative" && c.row.change_id === g.ghost?.change_id);
    const at = placed.get(g.id) ?? { rows: [], refs: [] };
    return {
      id: g.id, title: g.title, short_id: g.short_id, row: g.row, description: g.description, depth, owner: g.owner,
      ...(proposed ? { proposed } : {}),
      unknown: !g.row && !proposed,
      changes: mine.filter((c) => c !== proposed),
      projects: at.rows.map(docProject),
      refs: at.refs.map((r) => ({ project: docProject(r.project), under: r.under })),
      goals: (under.get(g.id) ?? []).map((k) => docGoal(k, depth + 1)),
    };
  };
  const goals = (under.get(null) ?? []).map((g) => docGoal(g, 1));

  // A project is under a goal when a live goal carries it today, or an
  // accepted change puts it there. One a proposal would place stays in the
  // list of projects no goal carries, and says where it would go.
  const filed = new Set<string>();
  const offered = new Map<string, string>();
  for (const { id, goal } of outline) {
    const drawn = new Set((placed.get(id)?.rows ?? []).map((p) => p.id));
    for (const p of goal.projects) {
      if (!p.ghost || p.ghost.solid) filed.add(p.id);
      else if (drawn.has(p.id) && !offered.has(p.id)) offered.set(p.id, goal.title);
    }
  }
  const unfiled = projects
    .filter((p) => !filed.has(p._id) && p.status !== "done")
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => ({ ...docProject({ id: p._id, title: p.title, short_id: p.short_id, status: p.status }), ...(offered.has(p._id) ? { proposedUnder: offered.get(p._id) } : {}) }));

  // Roles in the chart's order, each with what it leads and the goals it owns.
  const open = initiatives.filter((g) => g.status !== "cancelled" && g.status !== "completed");
  const ownedBy = (kind: "user" | "role", id: string): DocRef[] =>
    open.filter((g) => (g.owner?.kind === "role" ? kind === "role" && g.owner.role_id === id : g.owner?.kind === "user" && kind === "user" && g.owner.user_id === id)).map(refOf);
  const nameOfParent = (r: OrgRole): string | null =>
    r.reports_to.kind === "role"
      ? liveRoles.find((x) => x._id === (r.reports_to as { role_id: string }).role_id)?.name ?? null
      : tree.people.find((p) => p.user_id === (r.reports_to as { user_id: string }).user_id)?.name ?? null;
  const roles: DocRole[] = liveRoles.map((role) => ({
    role,
    charter: firstSentence(role.charter),
    reportsTo: nameOfParent(role),
    // A lead the project names or whose scope lists it; a whole workspace
    // role covers every project by the rule, which says nothing here.
    leads: projects.filter((p) => { const lead = projectLeadOf(p, liveRoles); return lead.kind === "lead" && lead.by !== "workspace" && lead.role._id === role._id; }).map((p) => ({ id: p._id, short_id: p.short_id, title: p.title })),
    goals: ownedBy("role", role._id),
    changes: onRole.get(role._id) ?? [],
  }));

  // People from the tree; before it arrives, the roster's own people.
  const member = new Map((input.roster ?? []).map((m) => [m._id, m]));
  const reportsOf = (userId: string) => liveRoles.filter((r) => r.reports_to.kind === "user" && r.reports_to.user_id === userId);
  const people: DocPerson[] = input.tree
    ? tree.people.map((p) => ({ id: p.user_id, name: p.name, image: p.image ?? member.get(p.user_id)?.image ?? member.get(p.user_id)?.github_avatar_url, me: p.is_me, username: member.get(p.user_id)?.github_username, roles: reportsOf(p.user_id), goals: ownedBy("user", p.user_id) }))
    : (input.roster ?? []).filter((m) => !m.is_bot).map((m) => ({ id: m._id, name: m.name || m.github_username || "Someone", image: m.image ?? m.github_avatar_url, me: false, username: m.github_username, roles: [], goals: ownedBy("user", m._id) }));

  const top = (under.get(null) ?? []).filter((g) => g.row);
  return {
    name: input.tree?.workspace.name?.trim() || input.workspaceName?.trim() || (input.tree?.workspace.kind === "team" ? "Company" : "Personal"),
    purpose: top.map((g) => g.row!.why?.trim() ?? "").filter(Boolean),
    tally: { goals: outline.filter((o) => o.goal.row).length, projects: projects.length, people: people.length, roles: roles.length },
    goals, unfiled, roles, people, staffing,
    waiting: rows.filter((r) => r.status === "proposed" || r.status === "failed").length,
  };
}

/** Every goal of the outline in reading order, for a lookup or a count. */
export function flatGoals(goals: readonly DocGoal[]): DocGoal[] {
  return goals.flatMap((g) => [g, ...flatGoals(g.goals)]);
}

/** "3 goals, 9 projects, 2 people, 2 roles". */
export function tallyLine(t: CompanyDoc["tally"]): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return [n(t.goals, "goal", "goals"), n(t.projects, "project", "projects"), n(t.people, "person", "people"), n(t.roles, "role", "roles")].join(", ");
}
