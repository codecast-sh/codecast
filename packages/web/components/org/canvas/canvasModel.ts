// The Org canvas as data (essence spec §4.1, §4.2). Pure: the org tree, the
// goals, projects, plans and tasks in; the mission, the goal tiles, one band
// per person and the No lead band out. The canvas draws exactly this, so the
// rules (where a project is drawn, which word a role's state says, the order
// of everything) are tested here without a DOM.
//
// One picture holds both charts: a goal tile names the projects that serve it
// and their leads; a person's band holds the roles that answer to them; a
// role's card holds the projects it leads, each naming its goal. A project is
// drawn whole once, inside its lead's card or in the No lead band.
import type { InitiativeRow, InitiativeUpdateHealth } from "@codecast/shared/contracts/initiative";
import { personRefOf } from "@codecast/shared/entities";
import { projectTaskCounts } from "@codecast/shared/tasks";
import type { BoardTask } from "../../../lib/initiatives";
import { firstSentence } from "../../company/companyModel";
import { namedLead, projectStatusSays, type LineProjectRow } from "../lines/lineData";
import { roleNodeId } from "../orgLayout";
import { roleWords } from "../orgStaffingTypes";
import type { OrgParentRef, OrgPerson, OrgRole, OrgTree } from "../orgTypes";
import type { SheetRef } from "../company/sheetStack";

/** What the canvas asks the panel to open: an object (a project may ask for
 *  its lead picker), or a conversation. A subset of the panel's PanelRef. */
export type CanvasOpenRef = (SheetRef & { intent?: "pick-lead" }) | { kind: "session"; id: string };

/** Whatever the panel holds now; the canvas rings the card it names. */
export type CanvasOpenTarget = { kind: string; ref?: string; id?: string } | null | undefined;

/** An open proposal's changes drawn in place (orgLayout's ghostsFor plan):
 *  the merged tree, and per role node what the card wears. */
export type CanvasGhosts = {
  merged: OrgTree;
  stubs: Readonly<Record<string, { line: string; solid: boolean }>>;
  retires: Readonly<Record<string, { line: string }>>;
  moves: readonly { nodeId: string; to: OrgParentRef; line: string }[];
};

export type CanvasPlanRow = { _id: string; short_id?: string; title: string; status?: string; owner_role_id?: string; progress?: { total: number; done: number; in_progress: number } };

export type CanvasInput = {
  tree: OrgTree | null;
  goals: readonly InitiativeRow[];
  projects: readonly LineProjectRow[];
  plans: readonly CanvasPlanRow[];
  tasks: readonly BoardTask[];
  /** False while the task store is still filling: counts draw dim. */
  tasksCounted?: boolean;
  /** Roles with a row in the viewer's Waits on you list. */
  waitingRoleIds: ReadonlySet<string>;
  viewerId: string | null;
  ghosts?: CanvasGhosts | null;
};

export type CanvasFace =
  | { kind: "person"; id: string; name: string; image?: string }
  | { kind: "role"; id: string; name: string; handle: string; avatar?: string };

export type CanvasRoleFace = Extract<CanvasFace, { kind: "role" }>;

export type CanvasGoalRef = { id: string; ref: string; title: string };

export type CanvasWork = { done: number; total: number; inProgress: number };

/** A project or plan as a block: on a role's card, or a card of its own in the No lead band. */
export type CanvasProject = {
  kind: "project" | "plan";
  id: string;
  ref: string;
  title: string;
  /** Said only when it says something: paused, planning. */
  status: string | null;
  work: CanvasWork | null;
  /** The task store is still filling: the count is partial. */
  counting: boolean;
  /** The adopted goals it serves, by title. */
  goals: CanvasGoalRef[];
  /** Where its count links: its board. */
  href: string;
};

export type RoleStateKind = "waiting" | "working" | "quiet" | "paused" | "not_started" | "handing_over";
export type RoleState = { kind: RoleStateKind; label: string };

export type CanvasSession = { id: string; title: string; state: "working" | "needs_input" };

export type CanvasRole = {
  id: string;
  ref: string;
  title: string;
  /** "Sorrel": the character it wears. */
  persona: string;
  handle: string;
  avatar?: string;
  /** The role it reports to, when that is a role. */
  under: string | null;
  state: RoleState;
  /** When its latest line was written. */
  at: number | null;
  line: string | null;
  projects: CanvasProject[];
  /** What it looks after when no project is drawn on its card: its charter's first sentence. */
  area: string | null;
  working: CanvasSession[];
  /** An open proposal's mark: a role it creates, a move, a retirement. */
  ghost?: { kind: "new"; line: string; solid: boolean } | { kind: "moves"; line: string; to: string } | { kind: "retires"; line: string };
};

export type CanvasPerson = { id: string; ref: string; name: string; image?: string; me: boolean; presence?: OrgPerson["presence"] };
export type CanvasBand = { person: CanvasPerson; roles: CanvasRole[] };

export type CanvasGoal = {
  id: string;
  ref: string;
  title: string;
  /** Said only once an update exists. */
  health: InitiativeUpdateHealth | null;
  owner: CanvasFace | null;
  latestUpdateId: string | null;
  serving: { id: string; ref: string; title: string; lead: CanvasRoleFace | null }[];
};

export type CanvasMission = { id: string; ref: string; title: string; workspace: string; owner: CanvasFace | null; health: InitiativeUpdateHealth | null };

export type CanvasModel = {
  mission: CanvasMission | null;
  goals: CanvasGoal[];
  /** Draft goals, folded to one tile. */
  drafts: number;
  bands: CanvasBand[];
  unled: CanvasProject[];
};

/** A goal someone adopted: it is being driven or is next. */
const ADOPTED = new Set(["active", "planned"]);
/** Work that ended draws nowhere on the canvas. */
const ENDED = new Set(["done", "completed", "archived", "cancelled", "canceled", "abandoned"]);
const PRIORITY = { p0: 0, p1: 1, p2: 2, p3: 3 } as const;

const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || 0;
const live = (r: OrgRole) => r.status !== "retired";

/** The word a role's state says, in the one order the canvas checks:
 *  Waiting on you only when the viewer's list has a row from it; a blocked
 *  pin with no ask of the viewer is Quiet, its line saying on whom it waits. */
export function roleStateOf(role: OrgRole, waiting: boolean, nameOfRole: (id: string, handle: string) => string): RoleState {
  if (waiting) return { kind: "waiting", label: "Waiting on you" };
  const handing = role.handing_over?.receivers.filter((r) => !r.done_at) ?? [];
  if (handing.length) return { kind: "handing_over", label: `Handing over to ${handing.map((r) => nameOfRole(r.role_id, r.handle)).join(", ")}` };
  if (role.status === "paused") return { kind: "paused", label: "Paused" };
  if (!role.standing) return { kind: "not_started", label: "Not started" };
  const working = role.standing.state === "working" || role.sessions.some((s) => s.state === "working");
  return working ? { kind: "working", label: "Working" } : { kind: "quiet", label: "Quiet" };
}

/** Goals by priority, then by when they were set. */
const goalOrder = (a: InitiativeRow, b: InitiativeRow) =>
  (a.priority ? PRIORITY[a.priority] : 9) - (b.priority ? PRIORITY[b.priority] : 9) || a.created_at - b.created_at;

/** The mission: the one top level adopted goal the other goals feed. */
export function missionOf(adopted: readonly InitiativeRow[]): InitiativeRow | null {
  const ids = new Set(adopted.map((g) => g._id));
  const roots = adopted.filter((g) => !g.parent_initiative_id || !ids.has(g.parent_initiative_id));
  if (roots.length !== 1) return null;
  return adopted.some((g) => g.parent_initiative_id === roots[0]._id) ? roots[0] : null;
}

export function canvasModel(input: CanvasInput): CanvasModel {
  const tree = input.ghosts?.merged ?? input.tree;
  const roles = (tree?.roles ?? []).filter(live);
  const people = tree?.people ?? [];
  const roleById = new Map(roles.map((r) => [r._id, r]));
  const personById = new Map(people.map((p) => [p.user_id, p]));
  const titleOf = (r: OrgRole) => roleWords(r).title;
  const nameOfRole = (id: string, handle: string) => { const r = roleById.get(id); return r ? titleOf(r) : `@${handle.replace(/^@/, "")}`; };
  const nameOfParent = (p: OrgParentRef) => (p.kind === "user" ? personById.get(p.user_id)?.name ?? "someone" : nameOfRole(p.role_id, p.role_id));

  const roleFace = (r: OrgRole): CanvasRoleFace => ({ kind: "role", id: r._id, name: titleOf(r), handle: r.handle, ...(r.avatar ? { avatar: r.avatar } : {}) });
  const ownerFace = (o: InitiativeRow["owner"]): CanvasFace | null => {
    if (!o) return null;
    if (o.kind === "role") { const r = roleById.get(o.role_id); return r ? roleFace(r) : null; }
    const p = personById.get(o.user_id);
    return p ? { kind: "person", id: p.user_id, name: p.name, ...(p.image ? { image: p.image } : {}) } : null;
  };
  const healthOf = (g: InitiativeRow) => (g.health && g.health !== "none" ? g.health : null);

  // Goals: the mission, the adopted tiles, the drafts as a count.
  const adopted = input.goals.filter((g) => ADOPTED.has(g.status)).sort(goalOrder);
  const missionRow = missionOf(adopted);
  const tiles = adopted.filter((g) => g !== missionRow);
  const goalRef = (g: InitiativeRow): CanvasGoalRef => ({ id: g._id, ref: g.short_id || g._id, title: g.title });
  const goalsOfProject = new Map<string, CanvasGoalRef[]>();
  for (const g of tiles) for (const pid of g.project_ids) (goalsOfProject.get(pid) ?? goalsOfProject.set(pid, []).get(pid)!).push(goalRef(g));

  // Projects: counted once over tasks bucketed by project.
  const projects = input.projects.filter((p) => !ENDED.has(p.status ?? ""));
  const projectById = new Map(projects.map((p) => [p._id, p]));
  const tasksOf = new Map<string, BoardTask[]>();
  for (const t of input.tasks) {
    if (!t.project_id) continue;
    const k = String(t.project_id);
    if (projectById.has(k)) (tasksOf.get(k) ?? tasksOf.set(k, []).get(k)!).push(t);
  }
  const counting = input.tasksCounted === false;
  const leadOf = (p: LineProjectRow) => namedLead(p, roles);
  const projectView = (p: LineProjectRow): CanvasProject => {
    const n = projectTaskCounts(tasksOf.get(p._id) ?? [], [p._id]);
    return {
      kind: "project", id: p._id, ref: p.short_id || p._id, title: p.title,
      status: projectStatusSays(p.status) ? p.status! : null,
      work: n.total > 0 ? { done: n.done, total: n.total, inProgress: n.in_progress } : null,
      counting,
      goals: goalsOfProject.get(p._id) ?? [],
      href: `/projects/${p.short_id || p._id}`,
    };
  };
  const planView = (p: CanvasPlanRow): CanvasProject => ({
    kind: "plan", id: p._id, ref: p.short_id || p._id, title: p.title,
    status: projectStatusSays(p.status) ? p.status! : null,
    work: p.progress && p.progress.total > 0 ? { done: p.progress.done, total: p.progress.total, inProgress: p.progress.in_progress } : null,
    counting: false,
    goals: [],
    href: `/plans/${p.short_id || p._id}`,
  });

  // Each project under its lead; each plan under its owner, else the first role whose area lists it.
  const projectsOfRole = new Map<string, CanvasProject[]>();
  const unled: CanvasProject[] = [];
  for (const p of [...projects].sort(byTitle)) {
    const lead = leadOf(p);
    if (lead) (projectsOfRole.get(lead._id) ?? projectsOfRole.set(lead._id, []).get(lead._id)!).push(projectView(p));
    else unled.push(projectView(p));
  }
  const rolesByTitle = [...roles].sort((a, b) => byTitle({ title: titleOf(a) }, { title: titleOf(b) }));
  for (const p of input.plans.filter((x) => !ENDED.has(x.status ?? "")).sort(byTitle)) {
    const owner = (p.owner_role_id && roleById.get(p.owner_role_id)) || rolesByTitle.find((r) => r.scope.plan_ids.includes(p._id));
    if (owner) (projectsOfRole.get(owner._id) ?? projectsOfRole.set(owner._id, []).get(owner._id)!).push(planView(p));
  }

  // Goal tiles name what serves them and who leads it.
  const goals: CanvasGoal[] = tiles.map((g) => ({
    ...goalRef(g),
    health: healthOf(g),
    owner: ownerFace(g.owner),
    latestUpdateId: g.latest_update_id ?? null,
    serving: g.project_ids.flatMap((pid) => {
      const p = projectById.get(pid);
      if (!p) return [];
      const lead = leadOf(p);
      return [{ id: p._id, ref: p.short_id || p._id, title: p.title, lead: lead ? roleFace(lead) : null }];
    }),
  }));

  // Bands: each role in the band of the person its reporting line ends at.
  const viewer = people.find((p) => p.is_me) ?? people.find((p) => p.user_id === input.viewerId) ?? people[0];
  const personOfRole = (r: OrgRole): string | undefined => {
    const seen = new Set<string>();
    let cur: OrgRole | undefined = r;
    while (cur && !seen.has(cur._id)) {
      seen.add(cur._id);
      if (cur.reports_to.kind === "user") return personById.has(cur.reports_to.user_id) ? cur.reports_to.user_id : undefined;
      cur = roleById.get(cur.reports_to.role_id);
    }
    return undefined;
  };
  const ghosts = input.ghosts;
  const ghostOf = (r: OrgRole): CanvasRole["ghost"] => {
    if (!ghosts) return undefined;
    const node = roleNodeId(r._id);
    const stub = ghosts.stubs[node];
    if (stub) return { kind: "new", line: stub.line, solid: stub.solid };
    const retire = ghosts.retires[node];
    if (retire) return { kind: "retires", line: retire.line };
    const move = ghosts.moves.find((m) => m.nodeId === node);
    return move ? { kind: "moves", line: move.line, to: nameOfParent(move.to) } : undefined;
  };
  const roleView = (r: OrgRole): CanvasRole => {
    const words = roleWords(r);
    const drawn = projectsOfRole.get(r._id) ?? [];
    const parent = r.reports_to.kind === "role" ? roleById.get(r.reports_to.role_id) : undefined;
    const standing = r.standing?.conversation_id;
    const ghost = ghostOf(r);
    return {
      id: r._id, ref: r.short_id, title: words.title, persona: words.name, handle: r.handle,
      ...(r.avatar ? { avatar: r.avatar } : {}),
      under: parent ? titleOf(parent) : null,
      state: roleStateOf(r, input.waitingRoleIds.has(r._id), nameOfRole),
      at: r.standing?.state_at ?? null,
      line: r.standing?.state_line?.trim() || null,
      projects: drawn,
      area: drawn.length ? null : firstSentence(r.charter),
      working: r.sessions
        .filter((s) => (s.state === "working" || s.state === "needs_input") && !s.is_anchor && s._id !== standing)
        .map((s) => ({ id: s._id, title: s.title || "Untitled session", state: s.state as CanvasSession["state"] })),
      ...(ghost ? { ghost } : {}),
    };
  };
  const rolesOfPerson = new Map<string, CanvasRole[]>();
  for (const r of rolesByTitle) {
    const home = personOfRole(r) ?? (personById.has(r.host_user_id) ? r.host_user_id : viewer?.user_id);
    if (home) (rolesOfPerson.get(home) ?? rolesOfPerson.set(home, []).get(home)!).push(roleView(r));
  }
  const bands: CanvasBand[] = [...people]
    .sort((a, b) => Number(b.user_id === viewer?.user_id) - Number(a.user_id === viewer?.user_id)
      || (rolesOfPerson.get(b.user_id)?.length ?? 0) - (rolesOfPerson.get(a.user_id)?.length ?? 0)
      || a.name.localeCompare(b.name))
    .map((p) => ({
      person: { id: p.user_id, ref: personRefOf({ _id: p.user_id }), name: p.name, ...(p.image ? { image: p.image } : {}), me: p.user_id === viewer?.user_id, ...(p.presence ? { presence: p.presence } : {}) },
      roles: rolesOfPerson.get(p.user_id) ?? [],
    }));

  const mission: CanvasMission | null = missionRow
    ? { ...goalRef(missionRow), workspace: tree?.workspace.name ?? "", owner: ownerFace(missionRow.owner), health: healthOf(missionRow) }
    : null;

  return { mission, goals, drafts: input.goals.filter((g) => g.status === "proposed").length, bands, unled };
}

/** Whether the open target names this object, by any of its ids. */
export function isOpenTarget(target: CanvasOpenTarget, kind: string, ...ids: readonly (string | undefined)[]): boolean {
  if (!target || target.kind !== kind) return false;
  const want = (target.ref ?? target.id ?? "").replace(/^@/, "").toLowerCase();
  return !!want && ids.some((id) => !!id && id.toLowerCase() === want);
}

/** What the canvas reads off the org tree, beyond what a line draws: when a
 *  role's line was written, the titles of the sessions it shows working, who
 *  a role reports to and what it is handing over. A message elsewhere in a
 *  session repaints nothing. */
export function canvasTreeSig(tree: OrgTree | null | undefined): string {
  if (!tree) return "";
  let sig = "";
  for (const r of tree.roles) {
    const live = r.sessions.filter((s) => s.state === "working" || s.state === "needs_input").map((s) => `${s._id}:${s.state}:${s.title}`).join(",");
    sig += `\n${r._id}|${r.given_name ?? ""}|${r.standing?.state_at ?? ""}|${r.handing_over?.receivers.map((x) => `${x.role_id}:${x.done_at ?? ""}`).join(",") ?? ""}|${(r.scope.plan_ids ?? []).join(",")}|${live}`;
  }
  return sig;
}
