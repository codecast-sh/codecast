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
import { changeLine, editedOrgChange, ORG_GOAL_KINDS, type OrgChange, type OrgChangeKind, type OrgChangeStatus } from "@codecast/shared/contracts/orgProposal";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { projectTaskCounts } from "@codecast/shared/tasks";
import { initiativeHref, type BoardTask } from "../../lib/initiatives";
import { roleHref } from "../charter/charterMeta";
import { goalsPlan, projectRows, type GoalGhost, type GoalOwner, type GoalProject, type PlanGoal, type PlanProject } from "../org/goalsLayout";
import { partyFace, proposalChangeRows, type ProposalTreeFace, type ProposalTreeRow } from "../org/proposalTree";
import { rolesInTreeOrder } from "../org/staffingModel";
import type { OrgProposalChange } from "../org/orgStaffingTypes";
import type { OrgRole, OrgTree } from "../org/orgTypes";

/** What the document reads off a project row. */
export type CompanyProject = GoalProject & { updated_at?: number };
/** What it reads off a roster member, when the org tree has not arrived. */
export type CompanyMember = { _id: string; name?: string; image?: string; github_avatar_url?: string; github_username?: string; is_bot?: boolean };

export type CompanyInput = {
  tree: OrgTree | null;
  /** The team's name, for a workspace whose tree has not arrived. */
  workspaceName?: string | null;
  initiatives: readonly InitiativeRow[];
  projects: readonly CompanyProject[];
  roster?: readonly CompanyMember[];
  /** The workspace's tasks, counted by the board's one rule (projectTaskCounts). */
  tasks?: readonly BoardTask[];
  /** False while the task store is still filling: a count read now would be partial. */
  tasksCounted?: boolean;
  /** The changes of every open proposal of this workspace. */
  changes?: readonly OrgProposalChange[];
  /** Those proposals, so a change links to the one it belongs to. */
  proposals?: readonly { _id: string; short_id: string }[];
};

/** A name and where it leads, when it names something with a page or a place on this one. */
export type DocLink = { name: string; href?: string };
/** The written record a goal change carries (I5): the words, so the page says what is being accepted. */
export type DocRecord = { why?: string; done_when?: string; milestones: string[] };

/** One proposed change as the document draws it: the row the proposal card
 *  draws, the proposal it belongs to (a verdict names what that proposal
 *  showed), and what a failed apply said. */
export type DocChange = {
  row: ProposalTreeRow;
  proposal_id: string;
  note?: string;
  /** A change that places a goal under another: the goal it lands under. */
  under?: string;
  /** Where each name on the row leads: a live role, person, goal or project
   *  by its page, a goal or role this proposal sets by its place on this
   *  page, and the proposal itself. */
  hrefs: { node?: string; owner?: string; parent?: string; from?: string; proposal?: string };
  /** What the row's own words leave unsaid, as a plain sentence: a change
   *  that writes a goal's record says nothing of it in its tag. */
  sentence?: string;
  record?: DocRecord;
};

export type DocProject = {
  id: string;
  title: string;
  short_id?: string;
  status?: string;
  /** The project's own last change: its latest activity. */
  updated_at?: number;
  /** Tasks open and done by the board's rule, when it counts any; "counting" while the task store is still filling. */
  counts: { open: number; done: number } | "counting" | null;
  /** The role the project names or whose scope lists it. Null when only a whole workspace role covers it: that says nothing about this project. */
  lead: OrgRole | null;
  /** The row is a proposal's: a project a change adds, or one a proposed goal would carry. */
  ghost?: GoalGhost;
};

export type DocGoal = {
  id: string;
  title: string;
  short_id?: string;
  /** The live row; absent on a goal a proposal sets. */
  row?: InitiativeRow;
  description?: string;
  /** Why it matters, in one reading (goalPurpose): the header and the goal's own line say the same words. */
  purpose: string | null;
  /** What a proposal writes on a goal it sets: why, done when, milestones. */
  record?: DocRecord;
  /** 1 for a top level goal, 2 for a goal that feeds one. */
  depth: number;
  /** Who owns it, or would. */
  owner: GoalOwner | null;
  ownerHref?: string;
  /** How a goal that has no row yet would be measured: "Fees collected → The first dollar". */
  measures: string[];
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
  /** Who it reports to. */
  reportsTo: DocLink | null;
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
  /** Their profile. */
  href: string;
  /** The roles that report to them. */
  roles: OrgRole[];
  goals: DocRef[];
};

export type DocPurpose = { text: string; /** Set by a proposal: the status of the change that sets the goal. */ status?: OrgChangeStatus };

export type CompanyDoc = {
  name: string;
  /** Why each top level goal matters, in the goals' order, as the tree will
   *  be: a top level goal a proposal sets says what the company is for in its
   *  change's status, until the store carries it. */
  purpose: DocPurpose[];
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
/** A change still waiting for its verdict. */
const DRAWN_WAITING = new Set(["proposed", "failed"]);
const NO_TREE: OrgTree = { workspace: { kind: "user", id: "", name: "" }, people: [], roles: [], anchors: [], generated_at: 0 };

/** Up to the first end of sentence, so "3.5 million" does not end one. */
export function firstSentence(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).replace(/\s+/g, " ").trim();
}

/** A goal's purpose sentence, read one way everywhere: why it matters, else
 *  the first sentence of what it is. */
export const goalPurpose = (why: string | null | undefined, description: string | null | undefined): string | null => why?.trim() || firstSentence(description);

/** A person's page, the address the team pages use. */
export const personHref = (m: { _id: string; github_username?: string }): string => `/team/${m.github_username || m._id}`;
export const projectHref = (id: string): string => `/projects/${id}`;
export const proposalHref = (shortId: string): string => `/org?proposal=${shortId}`;
/** Where a goal and a change sit on the document, for a link from elsewhere on it. */
export const goalAnchor = (id: string): string => `goal-${id}`;
export const changeAnchor = (id: string): string => `change-${id}`;

/** What a goal change writes to the record, as the words themselves. */
function recordOf(ch: OrgChange | null): DocRecord | undefined {
  if (ch?.kind !== "initiative" && ch?.kind !== "initiative_shape") return undefined;
  const why = ch.why?.trim() || undefined, done_when = ch.done_when?.trim() || undefined;
  const milestones = (ch.milestones ?? []).map((m) => m.title.trim()).filter(Boolean);
  return why || done_when || milestones.length ? { ...(why ? { why } : {}), ...(done_when ? { done_when } : {}), milestones } : undefined;
}
/** What names a shape change's goal. Its place and its numbers are said by the row's tag and detail (proposalTree goalRow); anything else it carries is not. */
const SHAPE_NAMES = new Set(["kind", "initiative", "title"]);
/** What a change's row leaves unsaid, as the sentence a person reads
 *  (changeLine): the record a shape change writes, or the whole change when
 *  the row has no words at all (`silent`). Under a goal's heading the goal is
 *  "this goal". */
function unsaidSentence(ch: OrgChange, silent: boolean): string | undefined {
  const words = GOAL_KINDS.has(ch.kind) ? { subject: "this goal" } : undefined;
  if (ch.kind === "initiative_shape") {
    const { parent: _parent, metrics: _metrics, ...rest } = ch;
    const writes = Object.entries(rest).some(([k, v]) => !SHAPE_NAMES.has(k) && v !== undefined && !(Array.isArray(v) && v.length === 0));
    if (writes) return changeLine(rest, words);
  }
  return silent ? changeLine(ch, words) : undefined;
}

const refOf = (g: Pick<InitiativeRow, "_id" | "short_id" | "title">): DocRef => ({ id: g._id, short_id: g.short_id || undefined, title: g.title });

/** The lead a project names or whose scope lists it. A whole workspace role
 *  covers every project by the rule, which says nothing about this one, so it
 *  is no lead here (the chart's Goals lens reads it the same way). */
export function namedLead(project: CompanyProject | undefined, roles: readonly OrgRole[]): OrgRole | null {
  const lead = project ? projectLeadOf(project, roles) : null;
  return lead?.kind === "lead" && lead.by !== "workspace" ? lead.role : null;
}

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
  const liveRoles = rolesInTreeOrder(input.tree);
  const liveRoleIds = new Set(liveRoles.map((r) => r._id));
  const projectById = new Map(projects.map((p) => [p._id, p]));

  // Where a name leads: its page when it is live, its place on this page when a proposal sets it.
  const member = new Map((input.roster ?? []).map((m) => [m._id, m]));
  const roleById = new Map(liveRoles.map((r) => [r._id, r]));
  const goalById = new Map(initiatives.map((g) => [g._id, g]));
  const proposalShort = new Map((input.proposals ?? []).map((p) => [p._id, p.short_id]));
  const drawnGoals = new Set(outline.map((o) => o.id));
  const drawnChanges = new Set(rows.map((r) => r.change_id));
  const hrefOf = (f: ProposalTreeFace | null | undefined): string | undefined => {
    switch (f?.kind) {
      case "person": return personHref(member.get(f.id) ?? { _id: f.id });
      case "role": { const r = roleById.get(f.id); return r ? roleHref(r) : drawnChanges.has(f.id) ? `#${changeAnchor(f.id)}` : undefined; }
      case "goal": { const g = goalById.get(f.id); return g ? initiativeHref(g) : drawnGoals.has(f.id) ? `#${goalAnchor(f.id)}` : undefined; }
      case "record": return f.record === "project" && projectById.has(f.id) ? projectHref(f.id) : undefined;
      default: return undefined;
    }
  };
  const docChange = (row: ProposalTreeRow): DocChange => {
    const c = changeById.get(row.change_id);
    const ch = c ? editedOrgChange(c.change, c.edits) : null;
    const places = ch?.kind === "initiative_shape" && !!ch.parent && row.parent;
    const short = c ? proposalShort.get(c.proposal_id) : undefined;
    const hrefs = Object.fromEntries(Object.entries({ node: hrefOf(row.node), owner: hrefOf(row.owner), parent: hrefOf(row.parent), from: hrefOf(row.from), proposal: short ? proposalHref(short) : undefined }).filter(([, v]) => v));
    const record = recordOf(ch);
    const sentence = ch ? unsaidSentence(ch, !(row.tag || row.chip || row.owner || row.detail || row.from || places)) : undefined;
    return {
      row, proposal_id: c?.proposal_id ?? "", hrefs,
      ...(row.status === "failed" && c?.applied_note ? { note: c.applied_note } : {}),
      ...(places ? { under: places.name } : {}),
      ...(sentence ? { sentence } : {}),
      ...(record ? { record } : {}),
    };
  };
  const onGoal = new Map<string, DocChange[]>();
  const onRole = new Map<string, DocChange[]>();
  const staffing: DocChange[] = [];
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

  const tasks = input.tasks ?? [];
  const docProject = (p: Pick<PlanProject, "id" | "title" | "short_id" | "status" | "ghost">): DocProject => {
    const row = projectById.get(p.id);
    // The number the project's own page shows: the rows its board would (projectTaskCounts).
    const n = projectTaskCounts(tasks, [p.id]);
    const counts = input.tasksCounted === false ? "counting" as const : n.total > 0 ? { open: n.total - n.done, done: n.done } : null;
    return { id: p.id, title: p.title, short_id: p.short_id ?? row?.short_id, status: p.status ?? row?.status, updated_at: row?.updated_at || undefined, counts, lead: namedLead(row, liveRoles), ...(p.ghost ? { ghost: p.ghost } : {}) };
  };
  const docGoal = (g: PlanGoal, depth: number): DocGoal => {
    const mine = onGoal.get(g.id) ?? [];
    const proposed = g.row ? undefined : mine.find((c) => c.row.kind === "initiative" && c.row.change_id === g.ghost?.change_id);
    const at = placed.get(g.id) ?? { rows: [], refs: [] };
    const record = proposed?.record;
    const ownerHref = hrefOf(g.owner);
    return {
      id: g.id, title: g.title, short_id: g.short_id, row: g.row, description: g.description, depth, owner: g.owner,
      purpose: g.row ? goalPurpose(g.row.why, g.row.description) : goalPurpose(record?.why, g.description),
      ...(record ? { record } : {}),
      ...(ownerHref ? { ownerHref } : {}),
      measures: g.row ? [] : g.chips.map((c) => c.chip),
      ...(proposed ? { proposed } : {}),
      unknown: !g.row && !proposed,
      changes: mine.filter((c) => c !== proposed),
      projects: at.rows.map(docProject),
      refs: at.refs.map((r) => ({ project: docProject(r.project), under: r.under })),
      goals: (under.get(g.id) ?? []).map((k) => docGoal(k, depth + 1)),
    };
  };
  const goals = (under.get(null) ?? []).map((g) => docGoal(g, 1));

  // A project is under a goal when a goal carries it today or an open
  // proposal would place it under one: the proposal's row already draws it
  // there, so listing it again as carried by nothing would name a problem the
  // proposal solves.
  const placedIds = new Set(outline.flatMap(({ goal }) => goal.projects.map((p) => p.id)));
  const unfiled = projects
    .filter((p) => !placedIds.has(p._id) && p.status !== "done")
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => docProject({ id: p._id, title: p.title, short_id: p.short_id, status: p.status }));

  // Roles in the chart's order, each with what it leads and the goals it owns.
  const open = initiatives.filter((g) => g.status !== "cancelled" && g.status !== "completed");
  const ownedBy = (kind: "user" | "role", id: string): DocRef[] =>
    open.filter((g) => (g.owner?.kind === "role" ? kind === "role" && g.owner.role_id === id : g.owner?.kind === "user" && kind === "user" && g.owner.user_id === id)).map(refOf);
  const reportsTo = (r: OrgRole): DocLink | null => {
    const f = partyFace(tree, r.reports_to);
    return f && f.kind !== "unknown" ? { name: f.name, href: hrefOf(f) } : null;
  };
  const roles: DocRole[] = liveRoles.map((role) => ({
    role,
    charter: firstSentence(role.charter),
    reportsTo: reportsTo(role),
    leads: projects.filter((p) => namedLead(p, liveRoles)?._id === role._id).map((p) => ({ id: p._id, short_id: p.short_id, title: p.title })),
    goals: ownedBy("role", role._id),
    changes: onRole.get(role._id) ?? [],
  }));

  // People from the tree; before it arrives, the roster's own people.
  const reportsOf = (userId: string) => liveRoles.filter((r) => r.reports_to.kind === "user" && r.reports_to.user_id === userId);
  const people: DocPerson[] = input.tree
    ? tree.people.map((p) => ({ id: p.user_id, name: p.name, image: p.image ?? member.get(p.user_id)?.image ?? member.get(p.user_id)?.github_avatar_url, me: p.is_me, href: personHref(member.get(p.user_id) ?? { _id: p.user_id }), roles: reportsOf(p.user_id), goals: ownedBy("user", p.user_id) }))
    : (input.roster ?? []).filter((m) => !m.is_bot).map((m) => ({ id: m._id, name: m.name || m.github_username || "Someone", image: m.image ?? m.github_avatar_url, me: false, href: personHref(m), roles: [], goals: ownedBy("user", m._id) }));

  return {
    name: input.tree?.workspace.name?.trim() || input.workspaceName?.trim() || (input.tree?.workspace.kind === "team" ? "Company" : "Personal"),
    // The top of the tree says what the company is for. A proposal that sets
    // it says so in its own status until the store carries the goal, so
    // accepting it never leaves the header with nothing to say.
    purpose: goals.flatMap((g) => (g.purpose ? [{ text: g.purpose, ...(g.proposed ? { status: g.proposed.row.status } : {}) }] : [])),
    tally: { goals: outline.filter((o) => o.goal.row).length, projects: projects.length, people: people.length, roles: roles.length },
    goals, unfiled, roles, people, staffing,
    waiting: rows.filter((r) => DRAWN_WAITING.has(r.status)).length,
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
