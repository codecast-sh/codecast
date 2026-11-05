// Tidy tree layout for the org page. Pure: tree + view state in, positioned
// nodes and edges out. No dependency: post order subtree widths, siblings
// spaced, parents centred over their children.
//
// Shape of the tree: people are roots, side by side, except a person who
// reports to another person, who hangs under them. Under a person hang the
// people and roles that report to them and a STACK of their own sessions (a vertical list, so a parent with eight sessions stays one column
// wide instead of eight). Roles nest the same way. A stack ends in a cluster
// card ("+N more") when the parent has more sessions than are loaded.
import type { OrgPerson, OrgRole, OrgSession, OrgTree, OrgParentRef, StateCounts } from "./orgTypes";
import type { OrgChangeKind, OrgChangeStatus } from "./orgStaffingTypes";
import type { OrgRoleSeat } from "@codecast/shared/contracts/orgProposal";
import { roleTenureChip, stateWords } from "./orgMeta";
import type { ZoomLevel } from "./orgZoom";
import { CARD, personFarHeight, roleCardRows, roleFarRows, roleMetaLine, runningSessions, sessionCardRows, sessionFarRows, wrapLines, type OrgSessionDetail, type RoleOpenDetail } from "./orgCardModel";

// ---------------------------------------------------------------- ghosts
// Open proposal changes drawn INTO the tree (docs/architecture/org-staffing.md
// S5). `ghostsFor` merges them into a copy of the tree (a proposed role is a
// stub role under its proposed parent; an accepted move or retire is already
// applied) and hands back, per node id, what the cards paint on top: a ghost
// stub, a retire overlay, a proposed move, chips. The layout carries
// those onto its nodes and edges so the canvas needs no second lookup.

/** One change as a card paints it: its id, status and one-line description. */
export type OrgGhostMeta = { change_id: string; status: OrgChangeStatus; line: string };
/** A chip on a node: scope, budget, trust, routine, file, projects, a
 *  project charter on its owner role, a move's own line, and any change whose
 *  handle nothing live answers to (`unresolved`, drawn as a warning on the
 *  viewer's own card so it can still be skipped or edited). `chip` is the
 *  delta alone (chipLine); `line` the full sentence, for the title. */
export type OrgGhostChip = OrgGhostMeta & { kind: OrgChangeKind; chip: string; unresolved?: boolean };
/** A stub node standing for a proposed role or an offered session. `solid`
 *  once accepted: it renders as a real card until org.tree echoes the row. */
export type OrgGhostStub = OrgGhostMeta & { kind: "role" | "adopt"; solid: boolean; this_session?: boolean; /** An adopt stub: the handle of the role the session joins. */ role_handle?: string; /** A role stub that names a session which already works as the role (org-roles-run-work.md R2). */ seat?: OrgRoleSeat };
export type OrgGhostMove = OrgGhostMeta & { nodeId: string; from: OrgParentRef; to: OrgParentRef };

export type OrgGhostPlan = {
  /** The tree with the stubs pushed and the accepted moves and retires applied. Lay THIS out. */
  merged: OrgTree;
  stubs: Record<string, OrgGhostStub>;
  retires: Record<string, OrgGhostMeta>;
  moves: OrgGhostMove[];
  chips: Record<string, OrgGhostChip[]>;
};

type GhostDecor = { ghost?: OrgGhostStub; retire?: OrgGhostMeta; move?: OrgGhostMove; chips?: OrgGhostChip[] };

export type OrgLayoutNode =
  // `h` is the card's height at the zoom level the layout was asked for (orgZoom).
  | ({ id: string; kind: "person"; x: number; y: number; w: number; h: number; person: OrgPerson; collapsed: boolean; hidden: number; overflow: number } & GhostDecor)
  | ({ id: string; kind: "role"; x: number; y: number; w: number; h: number; role: OrgRole; collapsed: boolean; hidden: number; overflow: number; tenure?: { short: string; full: string };
      /** Opened in place: the card lists its charter, leads, open tasks and sessions (`open` is what the store had). */ opened?: boolean; open?: RoleOpenDetail } & GhostDecor)
  | ({ id: string; kind: "session"; x: number; y: number; w: number; h: number; session: OrgSession; parent: OrgParentRef; /** What the card says under its title (orgSessionDetail); far, its first line is the summary. */ detail?: OrgSessionDetail; opened?: boolean } & GhostDecor)
  | { id: string; kind: "cluster"; x: number; y: number; w: number; h: number; parent: OrgParentRef; remaining: number; loaded: number; total: number; counts: StateCounts; fullyLoaded: boolean }
  // The product layer on the Everything chart (orgProductLayer): a goal under whoever owns it, a project under its lead with its sessions under it, the mission at the top, and one quiet group for what nobody owns yet.
  | { id: string; kind: "goal" | "project" | "mission"; x: number; y: number; w: number; h: number; data: Record<string, unknown> }
  | { id: string; kind: "group"; x: number; y: number; w: number; h: number; label: string; count: number };

/** `ghost`: a proposed edge into a stub, or a proposed move's edge to the new
 *  parent (then `change_id` names the move). `faded`: the old edge of a
 *  proposed move, drawn at 30%. `cross`: a project to a goal it serves in
 *  another branch, drawn only while either end is pointed at or selected. */
export type OrgLayoutEdge = { id: string; source: string; target: string; kind: "tree" | "stack" | "ghost" | "cross"; faded?: boolean; change_id?: string;
  /** Drawn as a spine down the parent's left edge into the card's side (the health map's columns). */
  spine?: boolean;
  /** How the edge is drawn on the tree: `lane` from the parent's bottom along a bus and down a spine left of the lane into the card's side; `spine` down the source's left edge into the card's side (a block's indented rows). Absent: a plain elbow, parent bottom to child top. */
  route?: "lane" | "spine" };

export type OrgLayoutView = {
  /** Node ids (person:<user_id> / role:<role_id>) whose subtree is folded. */
  collapsed: ReadonlySet<string>;
  /** Sessions loaded through org.sessionsUnder, keyed by parent node id. A key
   *  that is present (even with an empty list) means "show every loaded
   *  session", not just the first ORG_STACK_VISIBLE. */
  expanded: Readonly<Record<string, OrgSession[]>>;
  /** People and roles only, no session stacks: the health map draws how work
   *  moves between seats, and a column of sessions under each would bury it. */
  structureOnly?: boolean;
  /** False keeps the tree layout but draws no session stack under a card: its
   *  sessions are its counts and state dots (the map, org-staffing.md S40). */
  sessionCards?: boolean;
  /** What each session card says under its title, by conversation id
   *  (orgSessionDetail.sessionDetailsOf, from the store's inbox rows). */
  sessionDetails?: Readonly<Record<string, OrgSessionDetail>>;
  /** Role and session node ids opened in place: the card lists more, and the layout books it. */
  opened?: ReadonlySet<string>;
  /** What an opened role card lists from the store, by role id. */
  roleDetails?: Readonly<Record<string, RoleOpenDetail>>;
  /** The Everything chart: goals and projects joined into the people tree (orgProductLayer). */
  product?: OrgProductInput;
  /** Cards the person placed by hand (orgPlacement), by node id: where each
   *  sits relative to its parent card's top left (to the chart's origin for a
   *  top card). A placed card leaves its parent's lane or stack, which closes
   *  up, and its own branch lays out under it as usual. */
  placed?: Readonly<Record<string, { x: number; y: number }>>;
};

export type { OrgSessionDetail, RoleOpenDetail };

/** The product layer as the people tree places it: every card's height and
 *  data already resolved for the zoom level (orgProductLayer), so this module
 *  stays a pure tree layout. */
export type OrgProductInput = {
  /** The mission (or the company) card at the top, beside the first root. */
  mission: { h: number; w: number; data: Record<string, unknown> } | null;
  goals: { id: string; owner: OrgParentRef | null; h: number; w: number; data: Record<string, unknown> }[];
  projects: { id: string; lead: OrgParentRef | null; goalIds: string[]; h: number; w: number; data: Record<string, unknown> }[];
  /** Which project a session works on (its bound task's or plan's project, from the store). */
  sessionProject: Readonly<Record<string, string>>;
};

export const ORG_SIZES = {
  person: { w: CARD.person.w, h: 84 },
  /** A role's far card (its name, large); every nearer card is sized by orgCardModel.roleCardRows. */
  role: { w: CARD.role.w, h: CARD.role.far },
  /** A role on the health map (OrgNodeCards.HealthRoleCard): name, the week's two numbers, its signals. */
  healthRole: { w: 232, h: 122 },
  /** A session's far card; nearer cards are sized by orgCardModel.sessionCardRows. */
  session: { w: CARD.session.w, h: CARD.session.far },
  cluster: { w: CARD.cluster.w, h: 58 },
  /** The quiet "No owner yet" group header on the Everything chart. */
  group: { w: 300, h: 40 },
  /** Extra card height when a node carries ghost chips. */
  chipRow: 24,
  /** A quiet chip's line (OrgNodeCards.GhostChips `quiet`): what a goal card books per change on it. */
  quietChipRow: 20,
  /** A card lists this many changes as lines, then one line counting the rest. */
  quietChipMax: 3,
  /** Extra height of an adopt stub: a second line naming the role it joins. */
  adoptRow: 18,
  /** Close zoom level rows on a person card: up to three running sessions, one line each. */
  runningRow: 15,
  runningMax: 3,
  /** A person's line under the name (who they are, how many sessions) on a row of its own. */
  closeMetaRow: 22,
  closeMetaLine: 16,
  siblingGap: 40,
  levelGap: 56,
  stackGap: 8,
  rootGap: 96,
  /** Shallow branches (orgLayout measure): a row's indent under its card (rows are stackGap apart), the gap between blocks in a lane, and a lane's height floor. */
  indent: 28,
  laneGap: 20,
  /** The people at the top wrap into rows to make the whole chart about this wide for its height. */
  chartAspect: 2,
  /** The health map's columns (layoutOrgColumns): a report's indent, the gap between cards and between columns. */
  columnIndent: 28,
  columnGap: 22,
  columnRootGap: 56,
} as const;

/** Sessions drawn under a parent before the cluster card takes over. The tree
 *  payload carries TOP_N (8); the first click on the cluster reveals the rest
 *  of the payload, later clicks page org.sessionsUnder. */
export const ORG_STACK_VISIBLE = 5;

export const personNodeId = (userId: string) => `person:${userId}`;
export const roleNodeId = (roleId: string) => `role:${roleId}`;
export const sessionNodeId = (conversationId: string) => `session:${conversationId}`;
export const clusterNodeId = (parentId: string) => `cluster:${parentId}`;

export function parentNodeId(ref: OrgParentRef): string {
  return ref.kind === "user" ? personNodeId(ref.user_id) : roleNodeId(ref.role_id);
}

export function parentRefOfNodeId(id: string): OrgParentRef | null {
  if (id.startsWith("person:")) return { kind: "user", user_id: id.slice("person:".length) };
  if (id.startsWith("role:")) return { kind: "role", role_id: id.slice("role:".length) };
  return null;
}

// ---------------------------------------------------------------- hierarchy

export { runningSessions, roleMetaLine };
/** The list's rows plus the 6px it stands off what is above it (OrgNodeCards.RunningList). */
const runningRows = (holder: { sessions: OrgSession[] }) => { const n = runningSessions(holder).length; return n ? n * ORG_SIZES.runningRow + 6 : 0; };
/** How many lines a text takes wrapped by word at `chars` a line, one to three (the goal cards clamp at three). */
export const wrappedLines = (text: string, chars: number): number => wrapLines(text, chars, 3);
/** How many lines a card's changes take as quiet lines: one each up to the cap, then one more for the rest. */
export const quietChipLines = (n: number) => (n <= ORG_SIZES.quietChipMax ? n : ORG_SIZES.quietChipMax + 1);
/** A person's nearer card adds its meta line on a row of its own, its changes as lines, and its running sessions. */
const personFullExtra = (p: OrgPerson, chips: number) => ORG_SIZES.closeMetaRow + (chips ? Math.max(0, quietChipLines(chips) * ORG_SIZES.quietChipRow + 6 - ORG_SIZES.chipRow) : 0) + runningRows(p);

type Stack = { parent: OrgParentRef; /** The node the stack hangs under (a person, a role or a project). */ under: string; sessions: OrgSession[]; total: number; counts: StateCounts; hasMoreNode: boolean; fullyLoaded: boolean; /** Loaded sessions the person placed elsewhere on the chart (still this parent's). */ lifted?: number };

type Branch = {
  id: string;
  kind: "person" | "role" | "goal" | "project" | "group" | "mission" | "session";
  w: number;
  h: number;
  person?: OrgPerson;
  role?: OrgRole;
  /** A session the person placed by hand, drawn as a branch of its own, and the parent it is filed under. */
  session?: OrgSession;
  sessionParent?: OrgParentRef;
  /** A goal, project or mission card's data (orgProductLayer). */
  data?: Record<string, unknown>;
  label?: string;
  count?: number;
  /** A program seat's tenure chip (S10), resolved HERE because this is where
   *  the whole tree is in hand: the plan or project name lives in some other
   *  role's scope_names, so a card resolving it alone would show a raw id and
   *  would not repaint when the naming role's row changed. Absent = standing. */
  tenure?: { short: string; full: string };
  opened?: boolean;
  open?: RoleOpenDetail;
  children: Branch[];
  /** The parent's own sessions, drawn as a vertical stack under it. */
  stack: Stack | null;
  collapsed: boolean;
  /** Everything folded away under a collapsed node, for the card's count. */
  hidden: number;
  /** Sessions the stack does not draw (total minus drawn), for the card's tally. */
  overflow: number;
  // filled by measure()
  width: number;
  height: number;
};

/**
 * Every session id that any bucket in the tree files. A loaded page (view
 * .expanded) can hold a row the tree meanwhile filed elsewhere (a move that
 * echoed before the page pruned it); the tree's own bucket wins and the page
 * copy is not drawn, so one session is never two nodes.
 */
function bucketedIds(tree: OrgTree): Set<string> {
  const out = new Set<string>();
  for (const b of [...tree.people, ...tree.roles]) for (const s of b.sessions) out.add(s._id);
  return out;
}

function stackFor(parent: OrgParentRef, under: string, bucket: { sessions: OrgSession[]; total: number; counts: StateCounts }, view: OrgLayoutView, elsewhere: ReadonlySet<string>, skip?: (s: OrgSession) => boolean): Stack | null {
  const opened = under in view.expanded;
  const extra = view.expanded[under] ?? [];
  const seen = new Set(bucket.sessions.map((s) => s._id));
  const all = [...bucket.sessions, ...extra.filter((s) => !seen.has(s._id) && !elsewhere.has(s._id))];
  // Sessions that sit under one of this card's projects leave its own stack, and its counts.
  const loaded = skip ? all.filter((s) => !skip(s)) : all;
  const moved = all.length - loaded.length;
  const counts = moved ? { ...bucket.counts } : bucket.counts;
  if (moved) for (const s of all) if (skip!(s)) counts[s.state] = Math.max(0, (counts[s.state] ?? 0) - 1);
  const total = Math.max(bucket.total - moved, loaded.length);
  if (loaded.length === 0 && total === 0) return null;
  const sessions = opened ? loaded : loaded.slice(0, ORG_STACK_VISIBLE);
  const fullyLoaded = sessions.length >= total;
  // The cluster card appears when there is more to show, and stays (as "show
  // fewer") once the stack has been opened past the default five.
  const hasMoreNode = !fullyLoaded || opened;
  return { parent, under, sessions, total, counts, hasMoreNode, fullyLoaded };
}

type Stubs = Readonly<Record<string, OrgGhostStub>> | undefined;

/** How a session card is sized at this level: far is the title alone; nearer, what it says (orgCardModel). */
type SessionSizing = { stubs: Stubs; far: boolean; details?: Readonly<Record<string, OrgSessionDetail>>; opened?: ReadonlySet<string> };

/** A session row's height: an adopt stub carries a second line; nearer than far a session says where it stands and its task. */
function sessionHeight(s: OrgSession, sz: SessionSizing): number {
  if (sz.stubs?.[sessionNodeId(s._id)]?.kind === "adopt") return ORG_SIZES.session.h + ORG_SIZES.adoptRow;
  const opened = !!sz.opened?.has(sessionNodeId(s._id));
  if (sz.far && !opened) return sessionFarRows(s, sz.details?.[s._id]).h;
  return sessionCardRows(s, sz.details?.[s._id], opened).h;
}

function subtreeCount(b: Branch): number {
  let n = b.children.length + (b.stack ? b.stack.total : 0);
  for (const c of b.children) n += subtreeCount(c);
  return n;
}

export const goalNodeIdOf = (id: string) => `goal:${id}`;
export const projectNodeIdOf = (id: string) => `project:${id}`;
export const MISSION_NODE_ID = "mission";
export const UNOWNED_NODE_ID = "group:unowned";

export function buildBranches(tree: OrgTree, view: OrgLayoutView, ghosts?: Pick<OrgGhostPlan, "chips" | "stubs">, level: ZoomLevel = "close"): Branch[] {
  // Far, a card is its name; nearer, the full card (orgCardModel), sized from what it says.
  const far = level === "far";
  const full = !far && !view.structureOnly;
  const filed = bucketedIds(tree);
  const chipRow = (id: string) => (ghosts?.chips[id]?.length ? ORG_SIZES.chipRow : 0);
  // A seat's bot is a team member too, but the seat is drawn inside its
  // role's card (org-staffing.md S22), never as a person.
  const botIds = new Set(tree.anchors.map((a) => a.bot_user_id));
  const people = tree.people
    .filter((p) => !botIds.has(p.user_id))
    .sort((a, b) => Number(b.is_me) - Number(a.is_me) || a.name.localeCompare(b.name));
  const roles = tree.roles.filter((r) => r.status !== "retired");
  const roleIds = new Set(roles.map((r) => r._id));
  const personIds = new Set(people.map((p) => p.user_id));
  const peopleUnder = new Map<string, OrgPerson[]>();
  const topPeople: OrgPerson[] = [];
  for (const p of people) {
    const to = p.reports_to_user_id;
    if (to && to !== p.user_id && personIds.has(to)) peopleUnder.set(to, [...(peopleUnder.get(to) ?? []), p]);
    else topPeople.push(p);
  }
  // A loop (refused server side) reaches no top: draw its people as tops.
  const reached = new Set<string>();
  const reach = (id: string) => { if (reached.has(id)) return; reached.add(id); for (const r of peopleUnder.get(id) ?? []) reach(r.user_id); };
  for (const p of topPeople) reach(p.user_id);
  for (const p of people) if (!reached.has(p.user_id)) { topPeople.push(p); reach(p.user_id); }

  const rolesUnderUser = new Map<string, OrgRole[]>();
  const rolesUnderRole = new Map<string, OrgRole[]>();
  const orphanRoles: OrgRole[] = [];
  for (const r of roles) {
    const rt = r.reports_to;
    if (rt.kind === "user" && personIds.has(rt.user_id)) {
      rolesUnderUser.set(rt.user_id, [...(rolesUnderUser.get(rt.user_id) ?? []), r]);
    } else if (rt.kind === "role" && roleIds.has(rt.role_id) && rt.role_id !== r._id) {
      rolesUnderRole.set(rt.role_id, [...(rolesUnderRole.get(rt.role_id) ?? []), r]);
    } else {
      orphanRoles.push(r);
    }
  }
  // A role's seat is the role (org-staffing.md S16, S22): its state paints
  // on the role card and its hands stack under it. The anchors table is the
  // seat's storage and nothing here draws a node from it.

  // The product layer (Everything): goals under their owner, projects under
  // their lead, each project's sessions under it. What nobody owns or leads,
  // or whose owner is not on the chart, goes to the "No owner yet" group.
  const product = view.product;
  const nodeOf = (ref: OrgParentRef | null) => (ref && (ref.kind === "user" ? personIds.has(ref.user_id) : roleIds.has(ref.role_id)) ? parentNodeId(ref) : null);
  const goalsUnder = new Map<string, NonNullable<typeof product>["goals"]>();
  const projectsUnder = new Map<string, NonNullable<typeof product>["projects"]>();
  const unowned: Branch[] = [];
  const drawnProjects = new Set<string>();
  const projectSessions = new Map<string, OrgSession[]>();
  if (product) {
    for (const g of product.goals) { const at = nodeOf(g.owner); if (at) goalsUnder.set(at, [...(goalsUnder.get(at) ?? []), g]); }
    for (const p of product.projects) { drawnProjects.add(p.id); const at = nodeOf(p.lead); if (at) projectsUnder.set(at, [...(projectsUnder.get(at) ?? []), p]); }
    // A project's sessions: every session the tree or a loaded page holds that works on it.
    const pageRows = Object.values(view.expanded).flat();
    const seen = new Set<string>();
    for (const s of [...tree.people.flatMap((p) => p.sessions), ...tree.roles.flatMap((r) => r.sessions), ...pageRows]) {
      const pid = product.sessionProject[s._id];
      if (!pid || !drawnProjects.has(pid) || seen.has(s._id)) continue;
      seen.add(s._id);
      projectSessions.set(pid, [...(projectSessions.get(pid) ?? []), s]);
    }
  }
  const underProject = (s: OrgSession) => !!product && drawnProjects.has(product.sessionProject[s._id] ?? "");
  const leaf = (kind: "goal" | "mission", id: string, x: { h: number; w: number; data: Record<string, unknown> }): Branch =>
    ({ id, kind, w: x.w, h: x.h, data: x.data, children: [], stack: null, collapsed: false, hidden: 0, overflow: 0, width: 0, height: 0 });
  const projectBranch = (p: NonNullable<typeof product>["projects"][number]): Branch => {
    const id = projectNodeIdOf(p.id);
    const list = projectSessions.get(p.id) ?? [];
    const sorted = sortedByState(list);
    // The sessions are filed under their person or role; a move from here still names that parent.
    const parent = list[0] ? parentOfSession(tree, list[0]) : null;
    const stack = view.sessionCards === false || view.structureOnly || !parent || !list.length ? null
      : stackFor(parent, id, { sessions: sorted, total: sorted.length, counts: countsOf(sorted) }, view, new Set());
    return { id, kind: "project", w: p.w, h: p.h, data: p.data, children: [], stack, collapsed: false, hidden: 0, overflow: 0, width: 0, height: 0 };
  };
  const productKids = (nodeId: string): Branch[] => [
    ...(goalsUnder.get(nodeId) ?? []).map((g) => leaf("goal", goalNodeIdOf(g.id), g)),
    ...(projectsUnder.get(nodeId) ?? []).map(projectBranch),
  ];
  if (product) {
    for (const g of product.goals) if (!nodeOf(g.owner)) unowned.push(leaf("goal", goalNodeIdOf(g.id), g));
    for (const p of product.projects) if (!nodeOf(p.lead)) unowned.push(projectBranch(p));
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const visiting = new Set<string>();
  const isOpen = (id: string) => !!view.opened?.has(id);

  const roleBranch = (r: OrgRole): Branch => {
    const id = roleNodeId(r._id);
    const collapsed = view.collapsed.has(id);
    // A cycle in reports_to (refused server side, but never trust a snapshot)
    // would recurse forever: cut it here.
    const kids = visiting.has(r._id) ? [] : (rolesUnderRole.get(r._id) ?? []).sort(byName);
    visiting.add(r._id);
    // Resolved once, with the whole tree in hand; the row's height already
    // books the tenure row for a program, so the two agree by construction.
    const tenure = roleTenureChip(r.tenure, tree);
    // An opened card is the full card at every level; closed, far is the summary card.
    const opened = !view.structureOnly && isOpen(id);
    const open = opened ? view.roleDetails?.[r._id] ?? { leads: [], tasks: [] } : undefined;
    const h = view.structureOnly ? ORG_SIZES.healthRole.h
      : far && !opened ? roleFarRows(r).h
      : roleCardRows(r, { ghost: !!ghosts?.stubs[id], changes: ghosts?.chips[id]?.length ?? 0, tenure: r.tenure?.kind === "program", seat: ghosts?.stubs[id]?.seat, open }).h;
    const b: Branch = {
      id, kind: "role", w: view.structureOnly ? ORG_SIZES.healthRole.w : ORG_SIZES.role.w, h, role: r,
      ...(tenure ? { tenure } : {}),
      ...(opened ? { opened, open } : {}),
      children: collapsed ? [] : [...productKids(id), ...kids.map(roleBranch)],
      stack: collapsed || view.structureOnly || view.sessionCards === false ? null : stackFor({ kind: "role", role_id: r._id }, id, r, view, filed, product ? underProject : undefined),
      collapsed, hidden: 0, overflow: 0, width: 0, height: 0,
    };
    // No stack drawn (collapsed, or the map): every session is "not drawn", and the card's tally carries them all.
    b.overflow = b.stack ? Math.max(0, b.stack.total - b.stack.sessions.length) : collapsed || view.sessionCards === false ? r.total : 0;
    visiting.delete(r._id);
    if (collapsed) b.hidden = kids.length + r.total + kids.reduce((n, k) => n + subtreeCount(roleBranch(k)), 0) + productKids(id).length;
    return b;
  };
  const personBranch = (p: OrgPerson): Branch => {
    const id = personNodeId(p.user_id);
    const collapsed = view.collapsed.has(id);
    const kids = (rolesUnderUser.get(p.user_id) ?? []).sort(byName);
    // The same cycle cut as roles: a loop in the snapshot draws nothing twice.
    const reports = (peopleUnder.get(p.user_id) ?? []).filter((r) => !visiting.has(personNodeId(r.user_id)));
    visiting.add(id);
    const reportBranches = collapsed ? [] : reports.map(personBranch);
    visiting.delete(id);
    const b: Branch = {
      id, kind: "person", w: ORG_SIZES.person.w, h: (far ? personFarHeight(p.name, stateWords(p.counts, 2).length > 0) : ORG_SIZES.person.h) + chipRow(id) + (full ? personFullExtra(p, ghosts?.chips[id]?.length ?? 0) : 0), person: p,
      children: collapsed ? [] : [...productKids(id), ...kids.map(roleBranch), ...reportBranches],
      stack: collapsed || view.structureOnly || view.sessionCards === false ? null : stackFor({ kind: "user", user_id: p.user_id }, id, p, view, filed, product ? underProject : undefined),
      collapsed, hidden: 0, overflow: 0, width: 0, height: 0,
    };
    b.overflow = b.stack ? Math.max(0, b.stack.total - b.stack.sessions.length) : collapsed || view.sessionCards === false ? p.total : 0;
    if (collapsed) {
      visiting.add(id);
      b.hidden = kids.length + p.total + kids.reduce((n, k) => n + subtreeCount(roleBranch(k)), 0) + productKids(id).length
        + reports.reduce((n, r) => n + 1 + subtreeCount(personBranch(r)), 0);
      visiting.delete(id);
    }
    return b;
  };

  const roots = [
    ...(product?.mission ? [leaf("mission", MISSION_NODE_ID, product.mission)] : []),
    ...topPeople.map(personBranch),
    ...orphanRoles.sort(byName).map(roleBranch),
  ];
  if (unowned.length) {
    roots.push({ id: UNOWNED_NODE_ID, kind: "group", w: ORG_SIZES.group.w, h: ORG_SIZES.group.h, label: "No owner yet", count: unowned.length, children: unowned, stack: null, collapsed: false, hidden: 0, overflow: 0, width: 0, height: 0 });
  }
  return roots;
}

const STATE_RANK: Record<string, number> = { needs_input: 0, working: 1, dormant: 2, done: 3, idle: 4 };
const sortedByState = (list: OrgSession[]) => [...list].sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || b.updated_at - a.updated_at);
const countsOf = (list: OrgSession[]): StateCounts => { const c: StateCounts = { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0 }; for (const s of list) c[s.state] = (c[s.state] ?? 0) + 1; return c; };
/** The person or role a session is filed under in the tree, for a move that starts from a project's stack. */
function parentOfSession(tree: OrgTree, s: OrgSession): OrgParentRef | null {
  for (const r of tree.roles) if (r.sessions.some((x) => x._id === s._id)) return { kind: "role", role_id: r._id };
  for (const p of tree.people) if (p.sessions.some((x) => x._id === s._id)) return { kind: "user", user_id: p.user_id };
  if (s.org_role_id) return { kind: "role", role_id: s.org_role_id };
  return s.owner_user_id ? { kind: "user", user_id: s.owner_user_id } : null;
}

// ---------------------------------------------------------------- measure + place
//
// A wide, shallow org drawn as a plain tidy tree is a single row thousands of
// pixels long: every goal, every lead and every session stack takes a column
// of its own. So only a branch with depth (a child that has children of its
// own with children) spreads sideways. Everything shallow under a parent (a
// leaf, a lead whose reports are all leaves, the parent's own sessions) is a
// BLOCK: its card with what hangs under it indented below, joined by a spine.
// The blocks pack top to bottom into lanes, as many lanes as make the group
// about as wide as it is tall (never shorter than the tallest branch beside
// it), and the people at the top wrap into rows the same way, so the chart
// keeps a screen's proportions however many seats it has.

type Block = { /** The branch the block draws, or null for the parent's own stack. */ b: Branch | null; w: number; h: number };
type Plan = { lanes: { blocks: Block[]; w: number; h: number }[]; wide: Branch[] };

const plans = new WeakMap<Branch, Plan>();

const isShallow = (c: Branch) => c.children.every((k) => k.children.length === 0);

/** Height of a stack drawn as indented rows (sessions, then the cluster card). */
function stackRows(st: Stack, sz: SessionSizing): number {
  return st.sessions.reduce((h, s) => h + sessionHeight(s, sz) + ORG_SIZES.stackGap, 0) + (st.hasMoreNode ? ORG_SIZES.cluster.h + ORG_SIZES.stackGap : 0);
}
const stackWidth = (st: Stack | null) => (st && (st.sessions.length || st.hasMoreNode) ? Math.max(ORG_SIZES.session.w, ORG_SIZES.cluster.w) : 0);

/** A shallow branch as a block: its card, each leaf child indented with that child's sessions indented again, then its own sessions. */
function blockOf(c: Branch, sz: SessionSizing): Block {
  const I = ORG_SIZES.indent;
  let h = c.h + ORG_SIZES.stackGap;
  let w = c.w;
  for (const k of c.children) {
    h += k.h + ORG_SIZES.stackGap;
    w = Math.max(w, I + k.w);
    if (k.stack) { h += stackRows(k.stack, sz); w = Math.max(w, 2 * I + stackWidth(k.stack)); }
  }
  if (c.stack) { h += stackRows(c.stack, sz); w = Math.max(w, I + stackWidth(c.stack)); }
  return { b: c, w, h: h - ORG_SIZES.stackGap };
}

/** How tall a lane may grow: k lanes of width w and height H/k come out square when H/k = sqrt(H·w). */
function laneCap(blocks: Block[], wide: Branch[]): number {
  if (!blocks.length) return 0;
  const total = blocks.reduce((h, k) => h + k.h + ORG_SIZES.laneGap, -ORG_SIZES.laneGap);
  const w = blocks.reduce((a, k) => a + k.w, 0) / blocks.length;
  return Math.max(Math.sqrt(total * w), ...blocks.map((k) => k.h), ...wide.map((c) => c.height));
}

function measure(b: Branch, sz: SessionSizing): void {
  const wide = b.children.filter((c) => !isShallow(c));
  for (const c of wide) measure(c, sz);
  const blocks: Block[] = b.children.filter(isShallow).map((c) => blockOf(c, sz));
  if (b.stack && (b.stack.sessions.length || b.stack.hasMoreNode)) blocks.push({ b: null, w: stackWidth(b.stack), h: stackRows(b.stack, sz) - ORG_SIZES.stackGap });
  const cap = laneCap(blocks, wide);
  const lanes: Plan["lanes"] = [];
  for (const k of blocks) {
    const lane = lanes[lanes.length - 1];
    if (lane && lane.h + ORG_SIZES.laneGap + k.h <= cap) { lane.blocks.push(k); lane.h += ORG_SIZES.laneGap + k.h; lane.w = Math.max(lane.w, k.w); }
    else lanes.push({ blocks: [k], w: k.w, h: k.h });
  }
  plans.set(b, { lanes, wide });
  const parts = [...lanes.map((l) => l.w), ...wide.map((c) => c.width)];
  const childrenWidth = parts.length ? parts.reduce((a, w) => a + w, 0) + ORG_SIZES.siblingGap * (parts.length - 1) : 0;
  b.width = Math.max(b.w, childrenWidth);
  const below = Math.max(0, ...lanes.map((l) => l.h), ...wide.map((c) => c.height));
  b.height = b.h + (below > 0 ? ORG_SIZES.levelGap + below : 0);
}

function pushCard(b: Branch, x: number, y: number, out: OrgLayoutNode[], sz: SessionSizing): void {
  const box = { id: b.id, x, y, w: b.w, h: b.h };
  if (b.kind === "session") {
    const s = b.session!;
    const detail = sz.details?.[s._id];
    const opened = !!sz.opened?.has(b.id);
    out.push({ ...box, kind: "session", session: s, parent: b.sessionParent!, ...(detail ? { detail } : {}), ...(opened ? { opened } : {}) });
    return;
  }
  if (b.kind === "person") out.push({ ...box, kind: "person", person: b.person!, collapsed: b.collapsed, hidden: b.hidden, overflow: b.overflow });
  else if (b.kind === "role") out.push({ ...box, kind: "role", role: b.role!, collapsed: b.collapsed, hidden: b.hidden, overflow: b.overflow, ...(b.tenure ? { tenure: b.tenure } : {}), ...(b.opened ? { opened: true, open: b.open } : {}) });
  else if (b.kind === "group") out.push({ ...box, kind: "group", label: b.label ?? "", count: b.count ?? 0 });
  else out.push({ ...box, kind: b.kind, data: b.data ?? {} });
}

/** A stack's sessions and cluster card as rows from (x, y), each on `route` from `holder`. Returns the y below the last row. */
function placeStack(st: Stack, holder: string, x: number, y: number, route: "lane" | "spine", out: OrgLayoutNode[], edges: OrgLayoutEdge[], sz: SessionSizing): number {
  let sy = y;
  st.sessions.forEach((s, i) => {
    const id = sessionNodeId(s._id);
    const h = sessionHeight(s, sz);
    const detail = sz.details?.[s._id];
    const opened = !!sz.opened?.has(id);
    out.push({ id, kind: "session", x, y: sy, w: ORG_SIZES.session.w, h, session: s, parent: st.parent, ...(detail ? { detail } : {}), ...(opened ? { opened } : {}) });
    edges.push({ id: `e:${holder}->${id}`, source: holder, target: id, kind: i === 0 ? "tree" : "stack", route });
    sy += h + ORG_SIZES.stackGap;
  });
  if (st.hasMoreNode) {
    const id = clusterNodeId(holder);
    out.push({
      id, kind: "cluster", x, y: sy, w: ORG_SIZES.cluster.w, h: ORG_SIZES.cluster.h, parent: st.parent,
      remaining: Math.max(0, st.total - st.sessions.length - (st.lifted ?? 0)), loaded: st.sessions.length + (st.lifted ?? 0), total: st.total, counts: st.counts, fullyLoaded: st.fullyLoaded,
    });
    edges.push({ id: `e:${holder}->${id}`, source: holder, target: id, kind: st.sessions.length ? "stack" : "tree", route });
    sy += ORG_SIZES.cluster.h + ORG_SIZES.stackGap;
  }
  return sy;
}

function placeBlock(c: Branch, parent: string, x: number, y: number, out: OrgLayoutNode[], edges: OrgLayoutEdge[], sz: SessionSizing): void {
  const I = ORG_SIZES.indent;
  pushCard(c, x, y, out, sz);
  edges.push({ id: `e:${parent}->${c.id}`, source: parent, target: c.id, kind: "tree", route: "lane" });
  let cy = y + c.h + ORG_SIZES.stackGap;
  for (const k of c.children) {
    pushCard(k, x + I, cy, out, sz);
    edges.push({ id: `e:${c.id}->${k.id}`, source: c.id, target: k.id, kind: "tree", route: "spine" });
    cy += k.h + ORG_SIZES.stackGap;
    if (k.stack) cy = placeStack(k.stack, k.id, x + 2 * I, cy, "spine", out, edges, sz);
  }
  if (c.stack) placeStack(c.stack, c.id, x + I, cy, "spine", out, edges, sz);
}

function place(b: Branch, left: number, top: number, out: OrgLayoutNode[], edges: OrgLayoutEdge[], sz: SessionSizing): void {
  pushCard(b, left + (b.width - b.w) / 2, top, out, sz);
  const plan = plans.get(b)!;
  const parts = [...plan.lanes.map((l) => l.w), ...plan.wide.map((c) => c.width)];
  if (parts.length === 0) return;
  const childrenWidth = parts.reduce((a, w) => a + w, 0) + ORG_SIZES.siblingGap * (parts.length - 1);
  let cx = left + (b.width - childrenWidth) / 2;
  const cy = top + b.h + ORG_SIZES.levelGap;
  for (const lane of plan.lanes) {
    let y = cy;
    for (const k of lane.blocks) {
      if (k.b) placeBlock(k.b, b.id, cx, y, out, edges, sz);
      else placeStack(b.stack!, b.id, cx, y, "lane", out, edges, sz);
      y += k.h + ORG_SIZES.laneGap;
    }
    cx += lane.w + ORG_SIZES.siblingGap;
  }
  for (const c of plan.wide) {
    place(c, cx, cy, out, edges, sz);
    edges.push({ id: `e:${b.id}->${c.id}`, source: b.id, target: c.id, kind: "tree" });
    cx += c.width + ORG_SIZES.siblingGap;
  }
}

export type OrgLayout = { nodes: OrgLayoutNode[]; edges: OrgLayoutEdge[]; width: number; height: number };

type Lifted = { parent: string | null; rel: { x: number; y: number }; b: Branch };

/** Take the cards the person placed out of the tree: each leaves its parent's
 *  children or stack (which close up) and comes back as a branch of its own,
 *  with where it goes relative to that parent. */
function liftPlaced(roots: Branch[], placed: OrgLayoutView["placed"], sz: SessionSizing): { roots: Branch[]; lifted: Lifted[] } {
  const lifted: Lifted[] = [];
  if (!placed || Object.keys(placed).length === 0) return { roots, lifted };
  const lift = (b: Branch) => {
    b.children = b.children.filter((c) => {
      lift(c);
      if (!placed[c.id]) return true;
      lifted.push({ parent: b.id, rel: placed[c.id], b: c });
      return false;
    });
    const st = b.stack;
    if (st) {
      const keep: OrgSession[] = [];
      for (const s of st.sessions) {
        const id = sessionNodeId(s._id);
        if (!placed[id]) { keep.push(s); continue; }
        lifted.push({ parent: b.id, rel: placed[id], b: { id, kind: "session", w: ORG_SIZES.session.w, h: sessionHeight(s, sz), session: s, sessionParent: st.parent, children: [], stack: null, collapsed: false, hidden: 0, overflow: 0, width: 0, height: 0 } });
      }
      st.lifted = st.sessions.length - keep.length;
      st.sessions = keep;
      if (keep.length === 0 && !st.hasMoreNode) b.stack = null;
    }
  };
  const kept = roots.filter((r) => {
    lift(r);
    if (!placed[r.id]) return true;
    lifted.push({ parent: null, rel: placed[r.id], b: r });
    return false;
  });
  return { roots: kept, lifted };
}

/**
 * Lay the tree out. With `ghosts` (from `ghostsFor`, built from the SAME
 * tree) the merged tree is laid out instead and every node and edge carries
 * its ghost decoration: stubs, retire overlays, chips, the proposed edge of a
 * proposed move and the faded old one. With `view.product` the goals and
 * projects join the tree, and a project's cross edge to each goal it serves
 * that sits in another branch is added (drawn only on hover or selection).
 */
export function layoutOrgTree(tree: OrgTree, view: OrgLayoutView, ghosts?: OrgGhostPlan, /** The zoom level the cards are sized for (orgZoom). */ level: ZoomLevel = "close"): OrgLayout {
  if (view.structureOnly && !ghosts) return layoutOrgColumns(buildBranches(tree, view));
  const built = buildBranches(ghosts?.merged ?? tree, view, ghosts, level);
  const sz: SessionSizing = { stubs: ghosts?.stubs, far: level === "far", details: view.sessionDetails, opened: view.opened };
  const { roots, lifted } = liftPlaced(built, view.placed, sz);
  for (const r of roots) measure(r, sz);
  for (const l of lifted) measure(l.b, sz);
  const nodes: OrgLayoutNode[] = [];
  const edges: OrgLayoutEdge[] = [];
  // Roots wrap into rows: a row is as wide as makes the whole chart chartAspect wide for its height, and never narrower than its widest root.
  const area = roots.reduce((a, r) => a + (r.width + ORG_SIZES.rootGap) * (r.height + ORG_SIZES.rootGap), 0);
  const rowW = Math.max(Math.sqrt(area * ORG_SIZES.chartAspect), ...roots.map((r) => r.width));
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const r of roots) {
    if (x > 0 && x + r.width > rowW) { y += rowH + ORG_SIZES.rootGap; x = 0; rowH = 0; }
    place(r, x, y, nodes, edges, sz);
    width = Math.max(width, x + r.width);
    x += r.width + ORG_SIZES.rootGap;
    rowH = Math.max(rowH, r.height);
  }
  let height = y + rowH;
  // The placed cards, each at its spot beside its parent (parents first, so a
  // placed card inside a placed branch lands relative to where that one went).
  const at = new Map(nodes.map((n) => [n.id, n]));
  let pending = lifted;
  while (pending.length) {
    const later: Lifted[] = [];
    for (const l of pending) {
      const parent = l.parent ? at.get(l.parent) : null;
      if (l.parent && !parent) { later.push(l); continue; }
      const cx = (parent?.x ?? 0) + l.rel.x, cy = (parent?.y ?? 0) + l.rel.y;
      const from = nodes.length;
      place(l.b, cx - (l.b.width - l.b.w) / 2, cy, nodes, edges, sz);
      for (let i = from; i < nodes.length; i++) { const n = nodes[i]; at.set(n.id, n); width = Math.max(width, n.x + n.w); height = Math.max(height, n.y + n.h); }
      if (l.parent) edges.push({ id: `e:${l.parent}->${l.b.id}`, source: l.parent, target: l.b.id, kind: "tree" });
    }
    // A parent the chart does not draw (folded away): its placed cards go with it.
    if (later.length === pending.length) break;
    pending = later;
  }
  if (ghosts) decorate(nodes, edges, ghosts);
  if (view.product) {
    const parentOf = new Map(edges.filter((e) => e.kind === "tree").map((e) => [e.target, e.source]));
    const drawn = new Set(nodes.map((n) => n.id));
    for (const p of view.product.projects) {
      const pid = projectNodeIdOf(p.id);
      if (!drawn.has(pid)) continue;
      for (const g of p.goalIds) {
        const gid = goalNodeIdOf(g);
        if (drawn.has(gid) && parentOf.get(gid) !== parentOf.get(pid)) edges.push({ id: `x:${pid}->${gid}`, source: pid, target: gid, kind: "cross" });
      }
    }
  }
  return { nodes, edges, width, height };
}

/**
 * The health map's layout: a column per person, each seat's reports stacked
 * under it and indented, joined by a spine down the parent's left edge. An
 * org is wide and shallow (a few people, many leads), so the tree's own
 * layout fits it at a fraction of its size; columns keep every card legible.
 */
function layoutOrgColumns(roots: Branch[]): OrgLayout {
  const nodes: OrgLayoutNode[] = [];
  const edges: OrgLayoutEdge[] = [];
  let x = 0;
  let height = 0;
  const stack = (b: Branch, left: number, top: number, depth: number): { bottom: number; right: number } => {
    const nx = left + depth * ORG_SIZES.columnIndent;
    if (b.kind === "person") nodes.push({ id: b.id, kind: "person", x: nx, y: top, w: b.w, h: b.h, person: b.person!, collapsed: b.collapsed, hidden: b.hidden, overflow: b.overflow });
    else nodes.push({ id: b.id, kind: "role", x: nx, y: top, w: b.w, h: b.h, role: b.role!, collapsed: b.collapsed, hidden: b.hidden, overflow: b.overflow, ...(b.tenure ? { tenure: b.tenure } : {}) });
    let y = top + b.h + ORG_SIZES.columnGap;
    let right = nx + b.w;
    for (const c of b.children) {
      edges.push({ id: `e:${b.id}->${c.id}`, source: b.id, target: c.id, kind: "tree", spine: true });
      const r = stack(c, left, y, depth + 1);
      y = r.bottom;
      right = Math.max(right, r.right);
    }
    return { bottom: y, right };
  };
  for (const r of roots) {
    const { bottom, right } = stack(r, x, 0, 0);
    height = Math.max(height, bottom - ORG_SIZES.columnGap);
    x = right + ORG_SIZES.columnRootGap;
  }
  return { nodes, edges, width: Math.max(0, x - ORG_SIZES.columnRootGap), height };
}

function decorate(nodes: OrgLayoutNode[], edges: OrgLayoutEdge[], ghosts: OrgGhostPlan): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moveOf = new Map(ghosts.moves.map((m) => [m.nodeId, m]));
  for (const n of nodes) {
    if (n.kind !== "person" && n.kind !== "role" && n.kind !== "session") continue;
    decorateNode(n, ghosts, moveOf);
  }
  edgesOf(edges, ghosts, byId);
}

type Decorated = Extract<OrgLayoutNode, { kind: "person" | "role" | "session" }>;
function decorateNode(n: Decorated, ghosts: OrgGhostPlan, moveOf: Map<string, OrgGhostMove>): void {
  const stub = ghosts.stubs[n.id];
  if (stub) n.ghost = stub;
  const chips = ghosts.chips[n.id];
  if (chips?.length) n.chips = chips;
  if (n.kind !== "role") return;
  const retire = ghosts.retires[n.id];
  if (retire) n.retire = retire;
  const move = moveOf.get(n.id);
  if (move) n.move = move;
}

function edgesOf(edges: OrgLayoutEdge[], ghosts: OrgGhostPlan, byId: Map<string, OrgLayoutNode>): void {
  // The edge into a proposed (not yet accepted) stub is drawn as a ghost too.
  for (const e of edges) {
    const stub = ghosts.stubs[e.target];
    if (stub && !stub.solid && e.kind === "tree") e.kind = "ghost";
  }
  for (const m of ghosts.moves) {
    if (!byId.has(m.nodeId)) continue;
    const to = parentNodeId(m.to);
    if (!byId.has(to)) continue;
    const old = edges.find((e) => e.target === m.nodeId && e.kind !== "stack");
    if (old) old.faded = true;
    edges.push({ id: `g:${m.change_id}`, source: to, target: m.nodeId, kind: "ghost", change_id: m.change_id });
  }
}

/**
 * What the chart pans to (OrgGraph's `focusTarget`): a change (its ghost) or
 * a node, whichever the person asked for LAST. One ordered target instead of
 * two competing props, so a flag row clicked after a change row wins, and
 * `seq` makes a repeat click on the same row pan again after the person
 * dragged away.
 */
export type OrgFocusTarget = { kind: "change" | "node"; id: string; seq: number; /** Pan only when the node is not already on screen (a hover from the conversation). */ ifHidden?: boolean };

/** The layout node a focus target lands on; null when it has no place. */
export function focusTargetNodeId(ghosts: OrgGhostPlan | null | undefined, target: OrgFocusTarget | null | undefined): string | null {
  if (!target) return null;
  return target.kind === "change" ? ghostNodeIdFor(ghosts, target.id) : target.id;
}

/** The node a change is drawn on, for focus: its stub, its subject, or the
 *  node carrying its chip. Null when the change has no place on the chart. */
export function ghostNodeIdFor(ghosts: OrgGhostPlan | null | undefined, changeId: string | null | undefined): string | null {
  if (!ghosts || !changeId) return null;
  for (const [id, s] of Object.entries(ghosts.stubs)) if (s.change_id === changeId) return id;
  for (const [id, r] of Object.entries(ghosts.retires)) if (r.change_id === changeId) return id;
  const move = ghosts.moves.find((m) => m.change_id === changeId);
  if (move) return move.nodeId;
  for (const [id, chips] of Object.entries(ghosts.chips)) if (chips.some((c) => c.change_id === changeId)) return id;
  return null;
}

/** Axis aligned overlap test, used by the tests and the drop target search. */
export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
