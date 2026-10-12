// The company as one document
// (docs/architecture/initiatives-projects-role-page.md I5 "Where it shows").
// Pure: the org tree, the workspace's initiatives and projects, the roster and
// the open proposals' changes in; the document's outline out, in reading
// order: the company and one line of how it stands, its goals with what
// carries each, the projects no goal carries, then the people with the roles
// they host or that report to them.
//
// The document is the company as it IS: every live goal under its live
// parent, every live project under the goals that carry it today (listed
// once, under the goal nearest the work, `projectRows`) or among the projects
// no goal carries. An open proposal stands BESIDE that, never in its place:
// a goal it would set is a violet line where it would sit, a live goal it
// would move keeps its place and says where it would go, and a project or a
// goal it would bring under another goal is a violet "moves here" line under
// that goal, beside the real line that stays where it is. The proposal's
// reading is `goalsPlan`, the one the map's Goals lens draws, so the two
// never disagree about what a change does.
//
// Nothing here builds an address: every name is opened by its kind and ref
// (objectHref, or a sheet on the Org screen), and a proposed change by its
// proposal's short id and number.
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUSES, type InitiativeHealth, type InitiativeRow, type InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { GOAL_STATUS_WORD, goalSaysHealth } from "../org/lines/goalWords";
import { changeLine, editedOrgChange, ORG_GOAL_KINDS, type OrgChange, type OrgChangeKind, type OrgChangeStatus } from "@codecast/shared/contracts/orgProposal";
import { personRefOf } from "@codecast/shared/entities";
import { byListOrder, type BoardTask } from "../../lib/initiatives";
import { goalsPlan, projectRows, sessionsUnder, type GoalGhost, type GoalOwner, type PlanGoal, type PlanProject } from "../org/goalsLayout";
import { lineProjectOf, namedLead, type LineProject, type LineProjectRow } from "../org/lines/lineData";
import { partyFace, proposalChangeRows, type ProposalTreeFace, type ProposalTreeRow } from "../org/proposalTree";
import { rolesInTreeOrder } from "../org/staffingModel";
import type { OrgProposalChange } from "../org/orgStaffingTypes";
import type { OrgPerson, OrgRole, OrgTree, StateCounts } from "../org/orgTypes";

/** What the document reads off a project row. */
export type CompanyProject = LineProjectRow & { updated_at?: number };
/** What it reads off a roster member, when the org tree has not arrived; `joined_at` dates a person's line either way. */
export type CompanyMember = { _id: string; name?: string; image?: string; github_avatar_url?: string; github_username?: string; is_bot?: boolean; joined_at?: number };

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
  /** Those proposals, so a change names the one it belongs to. */
  proposals?: readonly { _id: string; short_id: string }[];
};

/** The written record a goal change carries (I5): the words, so the page says what is being accepted. */
export type DocRecord = { why?: string; done_when?: string; milestones: string[] };
/** Where a proposed change is answered: its proposal and its number there (`op-14#2`). */
export type ProposalRef = { short_id: string; seq: number };

/** One proposed change as the document draws it: the row the proposal card
 *  draws, the proposal it belongs to, and what a failed apply said. */
export type DocChange = {
  row: ProposalTreeRow;
  proposal_id: string;
  /** Absent while the proposal's own row has not arrived. */
  proposal?: ProposalRef;
  note?: string;
  /** A change that places a goal under another: the goal it lands under. */
  under?: string;
  /** What the row's own words leave unsaid, as a plain sentence: a change
   *  that writes a goal's record says nothing of it in its tag. */
  sentence?: string;
  record?: DocRecord;
};

export type DocGhost = GoalGhost & { proposal?: ProposalRef };

export type DocProject = LineProject & {
  /** The project's own last change: its latest activity. */
  updated_at?: number;
  /** The line is a proposal's: a project a change adds to a goal, or one a goal it sets would carry. */
  ghost?: DocGhost;
  /** The project does not exist yet: a proposal would create it. */
  unborn?: true;
};

export type DocGoal = {
  id: string;
  title: string;
  short_id?: string;
  /** The live row; absent on a goal a proposal sets. */
  row?: InitiativeRow;
  description?: string;
  /** Why it matters, in one reading (goalPurpose). */
  purpose: string | null;
  /** What a proposal writes on a goal it sets: why, done when, milestones. */
  record?: DocRecord;
  /** 1 for a top level goal, 2 for a goal that feeds one. */
  depth: number;
  /** Who owns it, or would. */
  owner: GoalOwner | null;
  /** How a goal that has no row yet would be measured: "Fees collected → The first dollar". */
  measures: string[];
  /** The change that sets this goal, when it is proposed and not yet in the store. */
  proposed?: DocChange;
  /** A goal a change names that nothing live or proposed answers to. */
  unknown: boolean;
  /** Every other change on the goal: its numbers, its owner, its projects, its record. */
  changes: DocChange[];
  /** A live goal a proposal would place under another goal: the change, which names where (`under`). */
  move?: DocChange;
  /** Live goals a proposal would bring under this one: each stays where it is
   *  today and is named here as a violet "moves here" line. */
  arriving: DocArrival[];
  /** The live projects it carries and is the nearest goal for, then (ghost) a
   *  project a proposal would add here: one that exists opens like any other. */
  projects: DocProject[];
  /** Projects it carries that are listed under another goal. */
  refs: { project: DocProject; under: string }[];
  goals: DocGoal[];
};

export type DocRef = { id: string; short_id?: string; title: string };
/** A live goal an open proposal would move under another one. */
export type DocArrival = { goal: DocRef; change: DocChange };
/** A person or a role, as a name and what opens it. */
export type DocParty = { kind: "person" | "role"; id: string; name: string; ref: string };
export type DocRole = {
  role: OrgRole;
  /** The charter's first sentence. */
  charter: string | null;
  /** Who it reports to. */
  reportsTo: DocParty | null;
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
  /** What opens them: their handle (personRefOf). */
  ref: string;
  /** Owner, admin or member of the workspace. */
  access?: OrgPerson["role"];
  presence?: OrgPerson["presence"];
  /** Their sessions, by state (the server's whole tally); null when they run none. */
  sessions: StateCounts | null;
  joined_at?: number;
  /** The roles that report to them. */
  roles: OrgRole[];
  goals: DocRef[];
};

/** The people and roles section in reading order: each person, then the
 *  roles they host or that report to them, a role under the role it reports
 *  to, and a role a proposal would hire where it would sit. Roles nobody in
 *  the workspace hosts come last. */
export type DocPeopleRow =
  | { kind: "person"; id: string; person: DocPerson; depth: 0 }
  /** `underReportsTo`: it sits under the person or role it reports to, so its line need not name them. */
  | { kind: "role"; id: string; role: DocRole; depth: number; underReportsTo: boolean }
  | { kind: "ghost"; id: string; change: DocChange; depth: number };

export type DocState = {
  /** Open goals by health, and by status for those no health word says yet (goalStateWord). */
  goals: { total: number; health: Partial<Record<InitiativeHealth, number>>; status?: Partial<Record<InitiativeStatus, number>> };
  /** Projects not finished, and how many have a session working under them. */
  projects: { total: number; moving: number };
  people: number;
  roles: number;
  /** What open proposals would add: goals they set, projects they create. Never counted with the live ones. */
  proposed: { goals: number; projects: number };
};

export type CompanyDoc = {
  name: string;
  state: DocState;
  goals: DocGoal[];
  unfiled: DocProject[];
  roles: DocRole[];
  people: DocPerson[];
  outline: DocPeopleRow[];
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

/** A scope change on a role, said from the role's own line: "would lead
 *  Callers & Call Management", "would stop leading Platform". */
function scopeSentence(ch: Extract<OrgChange, { kind: "scope" }>, projects: readonly { _id: string; short_id?: string | null; title: string }[]): string | undefined {
  const name = (ref: string) => projects.find((p) => p._id === ref || p.short_id === ref)?.title ?? ref;
  const list = (refs: readonly string[] | undefined) => (refs?.length ? refs.map(name).join(" and ") : null);
  const add = list(ch.add), remove = list(ch.remove);
  const parts = [add ? `would lead ${add}` : null, remove ? `${add ? "and stop leading" : "would stop leading"} ${remove}` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

const refOf = (g: Pick<InitiativeRow, "_id" | "short_id" | "title">): DocRef => ({ id: g._id, short_id: g.short_id || undefined, title: g.title });
/** A person's whole tally from the server (the tree carries only their first few sessions); null when they run none. */
const tallyOf = (c: StateCounts | undefined): StateCounts | null => (c && Object.values(c).some((n) => n > 0) ? c : null);

export function companyDoc(input: CompanyInput): CompanyDoc {
  const { initiatives, projects } = input;
  const tree = input.tree ?? NO_TREE;
  // Without the tree a change has no faces and no place: the plain outline.
  const changes = input.tree ? input.changes ?? [] : [];
  const { goals: plan, changeGoal } = goalsPlan({ tree, initiatives, projects, changes });

  // The live tree is the base: a live goal sits under its live parent; a
  // goal a proposal sets, where the proposal puts it. A cycle in parents
  // draws a goal once, and a goal no walk reaches still gets a line.
  const planById = new Map(plan.map((g) => [g.id, g]));
  const liveParent = (g: PlanGoal): string | null => {
    if (!g.row) return g.parentId;
    const p = g.row.parent_initiative_id;
    return p && p !== g.id && planById.get(p)?.row ? p : null;
  };
  const kids = new Map<string | null, PlanGoal[]>();
  for (const g of plan) { const k = liveParent(g); kids.set(k, [...(kids.get(k) ?? []), g]); }
  // Live goals in the owner's list order (a move the proposal makes does not reorder them), then what the proposal sets.
  const liveRank = new Map([...initiatives].sort(byListOrder).map((g, i) => [g._id, i]));
  const rank = (g: PlanGoal) => (g.row ? liveRank.get(g.id) ?? 0 : g.order);
  for (const list of kids.values()) list.sort((a, b) => rank(a) - rank(b));
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
  for (const g of plan) walk(g, null, 1);
  // What carries each goal today: its live projects, each listed once.
  const placed = projectRows(outline.map((o) => ({ ...o, goal: { ...o.goal, projects: o.goal.projects.filter((p) => !p.ghost) } })));
  const liveCarried = new Set(outline.flatMap(({ goal }) => (goal.row ? goal.projects.filter((p) => !p.ghost).map((p) => p.id) : [])));
  // What a proposal would bring under a goal, each listed once too: a project
  // it adds to a goal, and a loose project a goal it sets would carry. A
  // project a live goal already carries stays with that goal.
  const ghostPlaced = projectRows(outline.map((o) => ({ ...o, goal: { ...o.goal, projects: o.goal.projects.filter((p) => p.ghost && (p.ghost.kind === "initiative_projects" || !liveCarried.has(p.id))) } })));

  // The proposal's rows, each on the goal, the role or the person it changes.
  const changeById = new Map(changes.map((c) => [c._id, c]));
  const rows = proposalChangeRows(input.tree, changes, { goals: initiatives, projects: projects.map((p) => ({ id: p._id, title: p.title, short_id: p.short_id })) }).filter((r) => DRAWN.has(r.status));
  const liveRoles = rolesInTreeOrder(input.tree);
  const liveRoleIds = new Set(liveRoles.map((r) => r._id));
  const projectById = new Map(projects.map((p) => [p._id, p]));
  const member = new Map((input.roster ?? []).map((m) => [m._id, m]));
  const proposalShort = new Map((input.proposals ?? []).map((p) => [p._id, p.short_id]));

  /** Where a change is answered. */
  const proposalOf = (changeId: string): ProposalRef | undefined => {
    const c = changeById.get(changeId);
    const short = c ? proposalShort.get(c.proposal_id) : undefined;
    return c && short ? { short_id: short, seq: c.seq } : undefined;
  };
  const docChange = (row: ProposalTreeRow): DocChange => {
    const c = changeById.get(row.change_id);
    const ch = c ? editedOrgChange(c.change, c.edits) : null;
    const places = ch?.kind === "initiative_shape" && !!ch.parent && row.parent;
    const record = recordOf(ch);
    const sentence = ch?.kind === "scope" ? scopeSentence(ch, projects)
      : ch ? unsaidSentence(ch, !(row.tag || row.chip || row.owner || row.detail || row.from || places)) : undefined;
    const proposal = proposalOf(row.change_id);
    return {
      row, proposal_id: c?.proposal_id ?? "",
      ...(proposal ? { proposal } : {}),
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

  const ctx = { tree: input.tree, roles: liveRoles, tasks: input.tasks ?? [], tasksCounted: input.tasksCounted };
  const docProject = (p: Pick<PlanProject, "id" | "title" | "short_id" | "status" | "ghost">): DocProject => {
    const row = projectById.get(p.id);
    const proposal = p.ghost ? proposalOf(p.ghost.change_id) : undefined;
    // A project a proposal adds has no row: its line is the plan's title and status alone.
    return {
      ...lineProjectOf(row ?? { _id: p.id, title: p.title }, ctx),
      title: p.title,
      ...(p.short_id ?? row?.short_id ? { short_id: p.short_id ?? row?.short_id } : {}),
      ...(p.status ?? row?.status ? { status: p.status ?? row?.status } : {}),
      ...(row?.updated_at ? { updated_at: row.updated_at } : {}),
      ...(p.ghost ? { ghost: { ...p.ghost, ...(proposal ? { proposal } : {}) } } : {}),
      ...(row ? {} : { unborn: true as const }),
    };
  };
  // A live goal the proposal would place under another: the change that does it.
  const moveOf = (g: PlanGoal): DocChange | undefined =>
    g.row && g.parentId !== liveParent(g) ? (onGoal.get(g.id) ?? []).find((c) => c.row.change_id === g.ghost?.change_id) : undefined;
  const arrivals = new Map<string, DocArrival[]>();
  for (const g of plan) {
    const move = moveOf(g);
    if (move && g.row && g.parentId) arrivals.set(g.parentId, [...(arrivals.get(g.parentId) ?? []), { goal: refOf(g.row), change: move }]);
  }
  const docGoal = (g: PlanGoal, depth: number): DocGoal => {
    const mine = onGoal.get(g.id) ?? [];
    const proposed = g.row ? undefined : mine.find((c) => c.row.kind === "initiative" && c.row.change_id === g.ghost?.change_id);
    const move = moveOf(g);
    const at = placed.get(g.id) ?? { rows: [], refs: [] };
    const record = proposed?.record;
    // What a proposal would add here, beside what is here today.
    const here = new Set([...at.rows, ...at.refs.map((r) => r.project)].map((p) => p.id));
    const added = (ghostPlaced.get(g.id)?.rows ?? []).filter((p) => !here.has(p.id));
    return {
      id: g.id, title: g.title, short_id: g.short_id, row: g.row, description: g.description, depth, owner: g.owner,
      purpose: g.row ? goalPurpose(g.row.why, g.row.description) : goalPurpose(record?.why, g.description),
      ...(record ? { record } : {}),
      measures: g.row ? [] : g.chips.map((c) => c.chip),
      ...(proposed ? { proposed } : {}),
      unknown: !g.row && !proposed,
      // A change that adds projects is said by their lines; a move by the goal's own line, unless it also sets numbers or writes the record.
      changes: mine.filter((c) => c !== proposed && c.row.kind !== "initiative_projects" && (c !== move || !!c.sentence || !!c.row.detail)),
      ...(move ? { move } : {}),
      arriving: arrivals.get(g.id) ?? [],
      projects: [...at.rows, ...added].map(docProject),
      refs: at.refs.map((r) => ({ project: docProject(r.project), under: r.under })),
      goals: (under.get(g.id) ?? []).map((k) => docGoal(k, depth + 1)),
    };
  };
  const goals = (under.get(null) ?? []).map((g) => docGoal(g, 1));

  // A project is under a goal when a live goal carries it today. One a
  // proposal would place is still loose until the proposal is applied: its
  // violet line under the proposed goal says where it would go.
  const unfiled = projects
    .filter((p) => !liveCarried.has(p._id) && p.status !== "done")
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => docProject({ id: p._id, title: p.title, short_id: p.short_id, status: p.status }));

  // Roles in the map's order, each with what it leads and the goals it owns.
  const open = initiatives.filter((g) => g.status !== "cancelled" && g.status !== "completed");
  const ownedBy = (kind: "user" | "role", id: string): DocRef[] =>
    open.filter((g) => (g.owner?.kind === "role" ? kind === "role" && g.owner.role_id === id : g.owner?.kind === "user" && kind === "user" && g.owner.user_id === id)).map(refOf);
  const partyOf = (f: ProposalTreeFace | null): DocParty | null => {
    if (f?.kind === "person") return { kind: "person", id: f.id, name: f.name, ref: personRefOf(member.get(f.id) ?? { _id: f.id }) };
    if (f?.kind === "role") { const r = liveRoles.find((x) => x._id === f.id); return r ? { kind: "role", id: r._id, name: r.name, ref: r.short_id } : null; }
    return null;
  };
  const roles: DocRole[] = liveRoles.map((role) => ({
    role,
    charter: firstSentence(role.charter),
    reportsTo: partyOf(partyFace(tree, role.reports_to)),
    leads: projects.filter((p) => namedLead(p, liveRoles)?._id === role._id).map((p) => ({ id: p._id, short_id: p.short_id, title: p.title })),
    goals: ownedBy("role", role._id),
    changes: onRole.get(role._id) ?? [],
  }));

  // People from the tree; before it arrives, the roster's own people.
  const reportsOf = (userId: string) => liveRoles.filter((r) => r.reports_to.kind === "user" && r.reports_to.user_id === userId);
  const people: DocPerson[] = input.tree
    ? tree.people.map((p) => {
      const m = member.get(p.user_id);
      return {
        id: p.user_id, name: p.name, image: p.image ?? m?.image ?? m?.github_avatar_url, me: p.is_me, ref: personRefOf(m ?? { _id: p.user_id }),
        access: p.role, ...(p.presence ? { presence: p.presence } : {}), sessions: tallyOf(p.counts),
        ...(m?.joined_at ? { joined_at: m.joined_at } : {}),
        roles: reportsOf(p.user_id), goals: ownedBy("user", p.user_id),
      };
    })
    : (input.roster ?? []).filter((m) => !m.is_bot).map((m) => ({
      id: m._id, name: m.name || m.github_username || "Someone", image: m.image ?? m.github_avatar_url, me: false, ref: personRefOf(m), sessions: null,
      ...(m.joined_at ? { joined_at: m.joined_at } : {}), roles: [], goals: ownedBy("user", m._id),
    }));

  const state: DocState = {
    goals: {
      total: open.length,
      health: open.reduce<Partial<Record<InitiativeHealth, number>>>((acc, g) => ({ ...acc, [g.health]: (acc[g.health] ?? 0) + 1 }), {}),
      status: open.filter((g) => !goalSaysHealth(g)).reduce<Partial<Record<InitiativeStatus, number>>>((acc, g) => ({ ...acc, [g.status]: (acc[g.status] ?? 0) + 1 }), {}),
    },
    projects: (() => {
      const live = projects.filter((p) => p.status !== "done");
      const moving = live.filter((p) => sessionsUnder(tree, [p._id]).some((x) => x.state === "working")).length;
      return { total: live.length, moving };
    })(),
    people: people.length,
    roles: roles.length,
    proposed: {
      goals: plan.filter((g) => !g.row && g.ghost?.kind === "initiative").length,
      projects: new Set(plan.flatMap((g) => g.projects.filter((p) => p.ghost && !projectById.has(p.id)).map((p) => p.id))).size,
    },
  };

  return {
    name: input.tree?.workspace.name?.trim() || input.workspaceName?.trim() || (input.tree?.workspace.kind === "team" ? "Company" : "Personal"),
    state,
    goals, unfiled, roles, people,
    outline: peopleOutline(people, roles, staffing),
    staffing,
    waiting: rows.filter((r) => DRAWN_WAITING.has(r.status)).length,
  };
}

/** The people and roles in reading order (DocPeopleRow). A role sits under
 *  the role or person it reports to; one that reports to nobody here sits
 *  under the person who hosts it; a role a proposal would hire sits under the
 *  person or role it would report to. The rest come last. */
export function peopleOutline(people: readonly DocPerson[], roles: readonly DocRole[], staffing: readonly DocChange[]): DocPeopleRow[] {
  const personIds = new Set(people.map((p) => p.id));
  const roleIds = new Set(roles.map((r) => r.role._id));
  const reportsKey = (r: OrgRole): string | null => {
    const to = r.reports_to;
    if (to.kind === "role" && roleIds.has(to.role_id) && to.role_id !== r._id) return `role:${to.role_id}`;
    if (to.kind === "user" && personIds.has(to.user_id)) return `person:${to.user_id}`;
    return null;
  };
  const parentOf = (r: OrgRole): string | null => reportsKey(r) ?? (personIds.has(r.host_user_id) ? `person:${r.host_user_id}` : null);
  const children = new Map<string | null, DocRole[]>();
  for (const r of roles) { const k = parentOf(r.role); children.set(k, [...(children.get(k) ?? []), r]); }
  // A hire waits beside the roles it would join.
  const hires = staffing.filter((c) => c.row.kind === "role");
  const hireParent = (c: DocChange): string | null => {
    const p = c.row.parent;
    if (p?.kind === "person" && personIds.has(p.id)) return `person:${p.id}`;
    if (p?.kind === "role" && roleIds.has(p.id)) return `role:${p.id}`;
    return null;
  };
  const ghosts = new Map<string | null, DocChange[]>();
  for (const c of hires) { const k = hireParent(c); ghosts.set(k, [...(ghosts.get(k) ?? []), c]); }

  const out: DocPeopleRow[] = [];
  const placed = new Set<string>();
  const roleRows = (key: string | null, depth: number) => {
    for (const r of children.get(key) ?? []) {
      if (placed.has(r.role._id)) continue;
      placed.add(r.role._id);
      out.push({ kind: "role", id: r.role._id, role: r, depth, underReportsTo: key !== null && reportsKey(r.role) === key });
      for (const c of r.changes) out.push({ kind: "ghost", id: c.row.change_id, change: c, depth: depth + 1 });
      roleRows(`role:${r.role._id}`, depth + 1);
    }
    for (const c of ghosts.get(key) ?? []) out.push({ kind: "ghost", id: c.row.change_id, change: c, depth });
  };
  for (const person of people) {
    out.push({ kind: "person", id: person.id, person, depth: 0 });
    roleRows(`person:${person.id}`, 1);
  }
  roleRows(null, 0);
  // A reporting cycle leaves roles no walk reached: they still get a line.
  for (const r of roles) if (!placed.has(r.role._id)) { placed.add(r.role._id); out.push({ kind: "role", id: r.role._id, role: r, depth: 0, underReportsTo: false }); }
  return out;
}

/** Every goal of the outline in reading order, for a lookup or a count. */
export function flatGoals(goals: readonly DocGoal[]): DocGoal[] {
  return goals.flatMap((g) => [g, ...flatGoals(g.goals)]);
}

/** Every project line of the outline, each with the goal it is listed under. */
export function goalProjects(goals: readonly DocGoal[]): { goal: DocGoal; projects: DocProject[] }[] {
  return flatGoals(goals).filter((g) => g.projects.length > 0).map((goal) => ({ goal, projects: goal.projects }));
}

const HEALTH_WORST: InitiativeHealth[] = ["off_track", "at_risk", "on_track", "none"];
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** How the company stands, in one line:
 *  "2 goals: 1 on track, 1 at risk · 4 projects, 3 with work moving · 4 people, 4 agent roles".
 *  A part with nothing in it says nothing. Once any goal has a health word,
 *  the rest are named too, each by the word its own line says ("1 not
 *  started"), so the parts add up to the total. */
export function stateLine(s: Omit<DocState, "proposed">): string {
  return stateClauses(s).map((c) => c.join(" ")).join(" · ");
}

/** The state line's clauses, each as the parts its commas split it into
 *  ("3 goals: 1 on track,", "1 at risk,", "1 not started"): a wide line
 *  breaks only between clauses, a narrow one at a comma, never in a word. */
export function stateClauses(s: Omit<DocState, "proposed">): string[][] {
  const health = HEALTH_WORST.slice(0, 3).reverse().filter((h) => s.goals.health[h]).map((h) => `${s.goals.health[h]} ${INITIATIVE_HEALTH_LABEL[h].toLowerCase()}`);
  if (health.length && s.goals.health.none) {
    // Said by status, the word each goal's line and card say (goalStateWord).
    const status = s.goals.status ?? {};
    const named = INITIATIVE_STATUSES.filter((st) => status[st]).map((st) => `${status[st]} ${GOAL_STATUS_WORD[st].toLowerCase()}`);
    health.push(...(named.length ? named : [`${s.goals.health.none} with no update`]));
  }
  const goals = s.goals.total ? (health.length ? [`${n(s.goals.total, "goal", "goals")}: ${health[0]}`, ...health.slice(1)] : [n(s.goals.total, "goal", "goals")]) : [];
  const projects = s.projects.total ? [n(s.projects.total, "project", "projects"), ...(s.projects.moving ? [`${s.projects.moving} with work moving`] : [])] : [];
  const team = [s.people ? n(s.people, "person", "people") : null, s.roles ? n(s.roles, "agent role", "agent roles") : null].filter((x): x is string => !!x);
  return [goals, projects, team].filter((c) => c.length > 0).map((c) => c.map((part, i) => (i < c.length - 1 ? `${part},` : part)));
}

/** The goal the document opens on before anyone has chosen: the top level
 *  goal at the worst health, the nearest target breaking a tie. When no top
 *  level goal is live it opens the first one, live or proposed; null only
 *  when there are no goals at all. */
export function defaultOpenGoal(goals: readonly DocGoal[]): string | null {
  const live = goals.filter((g) => g.row);
  if (live.length === 0) return goals[0]?.id ?? null;
  const rank = (g: DocGoal) => HEALTH_WORST.indexOf(g.row!.health);
  return [...live].sort((a, b) => rank(a) - rank(b) || (a.row!.target_date ?? Infinity) - (b.row!.target_date ?? Infinity))[0].id;
}
