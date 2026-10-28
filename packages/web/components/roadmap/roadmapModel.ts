// The goals and projects as a roadmap: one row per goal and per project, in
// the document's order (companyModel), each placed in time. Pure: the
// document, the project rows, the workspace's tasks and the org tree in;
// rows, the time domain and each row's history out.
//
// A row's span runs from when its work began (the row's creation, or its
// first task if that came earlier) to its target day. Its history is the
// burn-up of the tasks on its projects' boards (isOnProjectBoard, the rule
// every count in the app reads): how many existed and how many were done at
// each sample. A goal reads its own projects and those of the goals under
// it. Its pace is what closed in the last four weeks, and its forecast is
// the day the open tasks would all be done at that pace.
import type { InitiativeHealth, InitiativeMilestone, InitiativeOwner, InitiativeRow, InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { isOnProjectBoard } from "@codecast/shared/tasks";
import { initiativeEnded } from "../../lib/initiatives";
import type { CompanyDoc, DocGoal, DocProject } from "../company/companyModel";
import type { OrgRole, OrgSession, OrgTree, StateCounts } from "../org/orgTypes";
import { EMPTY_COUNTS } from "../org/orgTypes";

export const DAY = 86_400_000;
const PACE_WINDOW = 28 * DAY;
/** Samples a row's history holds, whatever its length. */
const SAMPLES = 64;
/** How far ahead a forecast is believed; later reads as "not at this pace". */
const FORECAST_HORIZON = 730 * DAY;

export type RoadTask = {
  _id: string;
  short_id?: string;
  title?: string;
  status?: string | null;
  project_id?: unknown;
  source?: string | null;
  promoted?: boolean | null;
  assignee?: string | null;
  triage_status?: string | null;
  created_at?: number;
  closed_at?: number;
  updated_at?: number;
};

export type RoadProject = { _id: string; created_at?: number; updated_at?: number; status?: string; target_date?: number };

export type TaskSession = { _id: string; title?: string; agent_status?: string; last_message_at?: number; agent_type?: string };

const STATE_OF: Record<string, OrgSession["state"]> = { working: "working", thinking: "working", compacting: "working", permission_blocked: "needs_input", needs_input: "needs_input", waiting: "needs_input" };

export type Sample = { t: number; done: number; total: number };

export type RoadRow = {
  /** `g:<id>` or `p:<goal>:<id>`: a project carried by two goals is two rows. */
  key: string;
  kind: "goal" | "project" | "role";
  id: string;
  /** What opens it: in-N or pj-N, else the id. */
  ref: string;
  title: string;
  depth: number;
  parent: string | null;
  /** Keys of the rows directly under it. */
  children: string[];
  status: InitiativeStatus | string;
  ended: boolean;
  health: InitiativeHealth | null;
  color?: string;
  start: number;
  target?: number;
  /** A project's deadline is the end of the viewer's own day; a goal's is a stored UTC day. */
  targetLocal: boolean;
  done: number;
  total: number;
  series: Sample[];
  /** Tasks closed and opened over the last four weeks. */
  pace: { closed: number; opened: number };
  /** The day the open tasks are all done at the pace; null when nothing closes, or it would take past the horizon. */
  forecast: number | null;
  milestones: InitiativeMilestone[];
  owner?: InitiativeOwner;
  lead: OrgRole | null;
  /** Roles whose area holds one of its projects, the lead first. */
  roles: OrgRole[];
  sessions: OrgSession[];
  counts: StateCounts | null;
  projectIds: string[];
  latestUpdate?: string;
  row?: InitiativeRow;
};

export type Roadmap = { rows: RoadRow[]; byKey: Map<string, RoadRow>; from: number; to: number; mission: InitiativeRow | null };

type TaskIndex = Map<string, { created: number[]; closed: number[]; tasks: RoadTask[] }>;

/** Board tasks by project, each with its creation and close stamps sorted. */
export function indexTasks(tasks: Iterable<RoadTask>): TaskIndex {
  const out: TaskIndex = new Map();
  for (const t of tasks) {
    if (!t.project_id || !isOnProjectBoard(t)) continue;
    const id = String(t.project_id);
    let e = out.get(id);
    if (!e) out.set(id, (e = { created: [], closed: [], tasks: [] }));
    e.tasks.push(t);
    if (t.created_at) e.created.push(t.created_at);
    if (t.status === "done") e.closed.push(t.closed_at ?? t.updated_at ?? t.created_at ?? 0);
  }
  for (const e of out.values()) { e.created.sort((a, b) => a - b); e.closed.sort((a, b) => a - b); }
  return out;
}

/** How many stamps are at or before t. */
function countTo(sorted: readonly number[], t: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

function merged(index: TaskIndex, ids: readonly string[]): { created: number[]; closed: number[] } {
  if (ids.length === 1) return index.get(ids[0]) ?? { created: [], closed: [] };
  const created: number[] = [], closed: number[] = [];
  for (const id of new Set(ids)) { const e = index.get(id); if (e) { created.push(...e.created); closed.push(...e.closed); } }
  return { created: created.sort((a, b) => a - b), closed: closed.sort((a, b) => a - b) };
}

/** A span's burn-up, pace and forecast from its tasks' stamps. */
export function history(stamps: { created: number[]; closed: number[] }, start: number, now: number) {
  const { created, closed } = stamps;
  const series: Sample[] = [];
  const span = Math.max(now - start, DAY);
  for (let i = 0; i <= SAMPLES; i++) {
    const t = start + (span * i) / SAMPLES;
    series.push({ t, done: countTo(closed, t), total: countTo(created, t) });
  }
  // Tasks without a creation stamp still count today.
  const total = Math.max(created.length, closed.length);
  const done = closed.length;
  const last = series[series.length - 1];
  last.total = total; last.done = done;
  const pace = { closed: done - countTo(closed, now - PACE_WINDOW), opened: created.length - countTo(created, now - PACE_WINDOW) };
  const open = total - done;
  const perDay = pace.closed / (PACE_WINDOW / DAY);
  const ahead = open === 0 || perDay === 0 ? null : (open / perDay) * DAY;
  const forecast = ahead === null || ahead > FORECAST_HORIZON ? null : now + ahead;
  return { series, done, total, pace, forecast };
}

const tasksStart = (stamps: { created: number[] }) => stamps.created[0];

/** Every project id a goal carries, its sub goals' included. */
function goalProjectIds(g: DocGoal): string[] {
  return [...(g.row?.project_ids ?? []).map(String), ...g.projects.map((p) => p.id), ...g.goals.flatMap(goalProjectIds)];
}

function rolesOver(tree: OrgTree | null, projectIds: readonly string[], first: OrgRole | null): OrgRole[] {
  const ids = new Set(projectIds);
  const roles = (tree?.roles ?? []).filter((r) => r.status !== "retired" && r.scope.project_ids.some((p) => ids.has(p)));
  return first ? [first, ...roles.filter((r) => r._id !== first._id)] : roles;
}

function countsOf(sessions: readonly OrgSession[]): StateCounts | null {
  if (!sessions.length) return null;
  const c = { ...EMPTY_COUNTS };
  for (const s of sessions) c[s.state] = (c[s.state] ?? 0) + 1;
  return c;
}

export type RoadInput = {
  doc: CompanyDoc;
  projects: readonly RoadProject[];
  tasks: readonly RoadTask[] | TaskIndex;
  tree: OrgTree | null;
  now: number;
  /** Show completed and cancelled goals and finished projects. */
  showEnded?: boolean;
  /** The session working on each task now, by task id (tasks.webActiveSessions). */
  taskSessions?: Record<string, TaskSession>;
  /** Goals: the goal tree. Roles: each role with the projects it leads or holds in its area. */
  group?: "goals" | "roles";
};

export function roadmap({ doc, projects, tasks, tree, now, showEnded, group = "goals", taskSessions = {} }: RoadInput): Roadmap {
  const index = tasks instanceof Map ? tasks : indexTasks(tasks);
  // The sessions on each project's tasks, as the tree's session shape.
  const onTasks = new Map<string, OrgSession[]>();
  for (const [pid, e] of index) {
    const list: OrgSession[] = [];
    for (const t of e.tasks) {
      const x = taskSessions[t._id];
      if (x) list.push({ _id: x._id, short_id: x._id.slice(0, 7), title: x.title ?? t.title ?? "", agent_type: x.agent_type ?? "", state: STATE_OF[x.agent_status ?? ""] ?? "idle", updated_at: x.last_message_at ?? 0, subagent_count: 0, is_anchor: false });
    }
    if (list.length) onTasks.set(pid, list);
  }
  const projectRow = new Map(projects.map((p) => [String(p._id), p]));
  const rows: RoadRow[] = [];
  const byKey = new Map<string, RoadRow>();
  const sessionsOf = (roles: OrgRole[], projectIds: readonly string[]) => {
    const seen = new Set<string>();
    return [...roles.flatMap((r) => r.sessions), ...projectIds.flatMap((id) => onTasks.get(id) ?? [])].filter((s) => (seen.has(s._id) ? false : (seen.add(s._id), true)));
  };

  const push = (r: RoadRow) => { rows.push(r); byKey.set(r.key, r); if (r.parent) byKey.get(r.parent)?.children.push(r.key); };

  const projectRowOf = (p: DocProject, parent: string | null, depth: number) => {
    if (p.ghost || p.unborn) return;
    const pr = projectRow.get(p.id);
    const ended = p.status === "done";
    if (ended && !showEnded) return;
    const stamps = index.get(p.id) ?? { created: [], closed: [] };
    const start = Math.min(pr?.created_at ?? now, tasksStart(stamps) ?? now);
    const h = history(stamps, start, now);
    const roles = rolesOver(tree, [p.id], p.lead);
    const sessions = sessionsOf(roles, [p.id]);
    push({
      key: `p:${parent ?? ""}:${p.id}`, kind: "project", id: p.id, ref: p.short_id ?? p.id, title: p.title, depth, parent, children: [],
      status: p.status ?? "active", ended, health: null, color: p.color, start,
      target: p.target_date, targetLocal: true, ...h,
      milestones: [], lead: p.lead, roles, sessions, counts: countsOf(sessions), projectIds: [p.id],
    });
  };

  const goalRow = (g: DocGoal, parent: string | null, depth: number) => {
    const row = g.row;
    if (!row || g.proposed) return;
    const ended = initiativeEnded(row.status);
    if (ended && !showEnded) return;
    const ids = [...new Set(goalProjectIds(g))];
    const stamps = merged(index, ids);
    const start = Math.min(row.created_at ?? now, tasksStart(stamps) ?? now);
    const h = history(stamps, start, now);
    const owner = row.owner;
    const ownerRole = owner?.kind === "role" ? tree?.roles.find((r) => r._id === owner.role_id) ?? null : null;
    const roles = rolesOver(tree, ids, ownerRole);
    const sessions = sessionsOf(roles, ids);
    const key = `g:${row._id}`;
    push({
      key, kind: "goal", id: row._id, ref: row.short_id ?? row._id, title: row.title, depth, parent, children: [],
      status: row.status, ended, health: row.health, start, target: row.target_date, targetLocal: false, ...h,
      milestones: [...(row.milestones ?? [])].sort((a, b) => (a.date ?? a.done_at ?? Infinity) - (b.date ?? b.done_at ?? Infinity)),
      owner: row.owner, lead: ownerRole, roles, sessions, counts: countsOf(sessions), projectIds: ids, row,
    });
    for (const p of g.projects) projectRowOf(p, key, depth + 1);
    for (const k of g.goals) goalRow(k, key, depth + 1);
  };

  // A mission (one top goal every other serves) reads as the page's subject:
  // its own projects first, then its goals at the top level.
  const mission = doc.goals.length === 1 && doc.goals[0].row && doc.goals[0].goals.length > 0 ? doc.goals[0] : null;
  if (group === "roles") {
    // Each project once, under the role that leads it, else every role whose
    // area holds it; projects nobody's area holds come last, on their own.
    const all = new Map<string, DocProject>();
    const walk = (g: DocGoal) => { for (const p of g.projects) if (!all.has(p.id)) all.set(p.id, p); g.goals.forEach(walk); };
    doc.goals.forEach(walk);
    for (const p of doc.unfiled) if (!all.has(p.id)) all.set(p.id, p);
    const placed = new Set<string>();
    const roles = (tree?.roles ?? []).filter((r) => r.status !== "retired");
    const under = (role: OrgRole) => [...all.values()].filter((p) => p.lead?._id === role._id || (!p.lead && role.scope.project_ids.includes(p.id)));
    for (const role of [...roles].sort((a, b) => under(b).length - under(a).length || a.name.localeCompare(b.name))) {
      const ps = under(role).filter((p) => showEnded || p.status !== "done");
      if (!ps.length) continue;
      const ids = ps.map((p) => p.id);
      const stamps = merged(index, ids);
      const starts = ps.map((p) => projectRow.get(p.id)?.created_at ?? now);
      const start = Math.min(...starts, tasksStart(stamps) ?? now);
      const targets = ps.map((p) => p.target_date).filter((t): t is number => !!t);
      const key = `r:${role._id}`;
      const sessions = sessionsOf([role], ids);
      push({
        key, kind: "role", id: role._id, ref: role.short_id, title: role.name, depth: 0, parent: null, children: [],
        status: role.status, ended: false, health: null, start, target: targets.length ? Math.max(...targets) : undefined, targetLocal: true,
        ...history(stamps, start, now), milestones: [], lead: role, roles: [role], sessions, counts: countsOf(sessions), projectIds: ids,
      });
      for (const p of ps) { projectRowOf(p, key, 1); placed.add(p.id); }
    }
    for (const p of all.values()) if (!placed.has(p.id)) projectRowOf(p, null, 0);
  } else if (mission) {
    for (const p of mission.projects) projectRowOf(p, null, 0);
    for (const g of mission.goals) goalRow(g, null, 0);
  } else {
    for (const g of doc.goals) goalRow(g, null, 0);
  }
  for (const p of doc.unfiled) projectRowOf(p, null, 0);

  // The domain: from the earliest start (at most a year back) to the latest
  // target or forecast, never less than two months either side of today.
  let from = now - 60 * DAY, to = now + 90 * DAY;
  for (const r of rows) {
    from = Math.min(from, Math.max(r.start, now - 365 * DAY));
    if (r.target) to = Math.max(to, r.target);
    if (r.forecast) to = Math.max(to, Math.min(r.forecast, now + 365 * DAY));
    for (const m of r.milestones) if (m.date) to = Math.max(to, m.date);
  }
  return { rows, byKey, from: from - 14 * DAY, to: to + 30 * DAY, mission: mission?.row ?? null };
}

/** How many goals and projects the view hides while finished ones are hidden. */
export function endedCount(doc: CompanyDoc): number {
  const projects = new Set<string>();
  let goals = 0;
  const walk = (g: DocGoal) => {
    if (g.row && initiativeEnded(g.row.status)) goals++;
    for (const p of g.projects) if (p.status === "done" && !p.ghost) projects.add(p.id);
    g.goals.forEach(walk);
  };
  doc.goals.forEach(walk);
  for (const p of doc.unfiled) if (p.status === "done") projects.add(p.id);
  return goals + projects.size;
}

/** Which way a row is heading against its target. */
export type Standing = "done" | "late" | "behind" | "on_pace" | "no_pace" | "no_date";
export function standingOf(r: RoadRow, now: number): Standing {
  if (r.ended || (r.total > 0 && r.done === r.total)) return "done";
  if (!r.target) return "no_date";
  if (r.target < now) return "late";
  if (r.total === 0 || r.forecast === null) return "no_pace";
  return r.forecast > r.target ? "behind" : "on_pace";
}

/** The rows a fold leaves showing. */
export function visibleRows(rows: readonly RoadRow[], folded: ReadonlySet<string>): RoadRow[] {
  const hidden = new Set<string>();
  const out: RoadRow[] = [];
  for (const r of rows) {
    if (r.parent && (hidden.has(r.parent) || folded.has(r.parent))) { hidden.add(r.key); continue; }
    out.push(r);
  }
  return out;
}
