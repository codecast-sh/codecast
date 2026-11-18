// Coverage (docs/architecture/initiatives-projects-role-page.md I1 "The org",
// I2 "Coverage"): who answers for each piece of work, read from the top of the
// tree down. ONE pure reading over rows, beside the activity reading
// (lib/orgActivity) whose areas it takes, so the analyzer's inputs state the
// before count and a test needs no database.
//
// It lists facts and judges nothing. A project with work planned or in
// progress (health's rule: an open task or an open plan, on an active project)
// names its lead by the one rule every surface reads (contracts/orgLead). Work
// outside any project is what the rows already say: an open plan with no
// project, open tasks with neither, and an area of commits and sessions that
// resolved to no project. A task is open work only when the project's board
// would list it and it is not done (`isOnProjectBoard`, contracts the page,
// the list, the scope cards and the server all read): an agent's suggestion
// or an unpromoted insight is not work to cover, so the counts here are the
// counts a person sees when they click through. Whether to wrap, share or
// split a lead is the Head of People's reading.

import { projectLeadOf, type LeadRole } from "@codecast/shared/contracts/orgLead";
import { initiativeChain, initiativeStanding, intentSourceAddress, metricReadings, metricTrends, nextMilestone, openQuestions, orderedMilestones, trendWords, type InitiativeLink, type InitiativeRow, type MetricReading, type MetricStanding } from "@codecast/shared/contracts/initiative";
import { isOnProjectBoard } from "@codecast/shared/tasks";
import { openPlansOf } from "@codecast/shared/contracts/openPlans";
import { isClosedPlan, type ActivityArea } from "./orgActivity";

export type CoverageRole = LeadRole & { handle: string };
export type CoverageProject = { _id: unknown; short_id?: string | null; title: string; status?: string; owner_role_id?: unknown };
export type CoveragePlan = {
  _id: unknown; short_id: string; title: string; status: string; project_id?: unknown;
  updated_at?: number; _creationTime?: number;
  progress?: { total: number; done: number; in_progress: number; open: number } | null;
  /** The session driving it (readUnplaced's driverOf), resolved by the caller; absent when not read. */
  driver?: SessionRef | null;
};
/** A session as an unplaced item or an open plan names it. */
export type SessionRef = { short_id: string; title: string; last_active_at: number };
/** An open plan as a goal lists it under its project (ct-95899). */
export type OpenPlanLine = { short_id: string; title: string; status: string; progress: { done: number; total: number } | null; last_activity_at: number; driver: SessionRef | null };
/** The fields the board rule reads, beside the two links; a raw task row satisfies it. */
export type CoverageTask = Parameters<typeof isOnProjectBoard>[0] & { status?: string | null; project_id?: unknown; plan_id?: unknown };
export type CoverageInitiative = Pick<InitiativeRow, "_id" | "short_id" | "title" | "status" | "owner" | "health" | "health_at" | "target_date" | "project_ids" | "parent_initiative_id" | "metrics" | "scoreboard" | "description" | "score_history" | "why" | "done_when" | "milestones" | "questions" | "decisions" | "sources">;

export type CoverageInputs = {
  projects: CoverageProject[];
  plans: CoveragePlan[];
  tasks: CoverageTask[];
  roles: CoverageRole[];
  areas: ActivityArea[];
  initiatives: CoverageInitiative[];
  /** user id → name, for an initiative a person owns. */
  userNames?: Record<string, string>;
};

/** `lead` is the role's handle. `watchers` are the roles on separate lines that list the project while it names none. */
/** `lead_paused` names the role that would lead the project if it were not paused: a paused
 *  seat drives nothing, so the project counts as without a lead until the person resumes or
 *  replaces it (two of Codecast's three leads were paused and read as leads, 2026-09-21). */
type LeadFacts = { lead?: string; lead_by?: "owner" | "scope"; lead_paused?: string; watchers?: string[] };

export type ProjectCoverage = LeadFacts & { id: string; short_id?: string; title: string; open_tasks: number; open_plans: number; initiatives: string[] };

export type InitiativeCoverage = {
  short_id: string;
  title: string;
  /** The goal in its author's words: what it is for, and any number they named. */
  description?: string;
  status: InitiativeRow["status"];
  health: InitiativeRow["health"];
  health_at?: number;
  target_date?: number;
  /** Absent means nobody drives it. */
  owner?: { kind: "role"; handle: string } | { kind: "user"; name: string };
  parent?: string;
  /** The goals above it, nearest first, up to the top level goal. */
  chain: InitiativeLink[];
  /** Each metric read against its target; empty when the goal names none. */
  metrics: MetricReading[];
  /** Against the numbers (initiativeStanding): behind if any metric is, met if every one is, within noise if every one is met or within noise, else unknown. The owner's `health` is their word; this is the target's. */
  standing: MetricStanding;
  /** Which way each metric is moving, by metric key, in words ("up from 380, toward the target"); a metric with fewer than two reports has no entry. */
  trends: Record<string, string>;
  // The intent record (I5): what a review reads to say what the goal still
  // lacks, and every entry the record holds, so it adds none a second time.
  /** Why it matters, in its author's words. */
  why?: string;
  /** What done looks like: the sentence a result is checked against. */
  done_when?: string;
  /** The first milestone not reached, earliest day first; absent when every one is reached or none is set. */
  next_milestone?: { title: string; date?: number };
  /** Every milestone in reading order, the reached ones marked. */
  milestones: Array<{ title: string; date?: number; done?: true }>;
  /** What is still undecided, as asked. */
  open_questions: string[];
  /** The questions already answered, as asked. */
  answered_questions: string[];
  /** What was decided, in the words on the record. */
  decisions: string[];
  /** Where the goal was stated: each source as the address a change would write for it ("call:cl-42:14", "ct-12", a URL), a note by its words. None means nobody can check who said it. */
  sources: string[];
  /** Each project with its open plans, newest activity first (openPlansOf), and how many more are open. */
  projects: Array<LeadFacts & { id: string; short_id?: string; title: string; has_work: boolean; open_plans: OpenPlanLine[]; more_plans: number }>;
  /** Of its projects with work, how many have no lead. */
  projects_without_lead: number;
};

export type OrgCoverage = {
  /** The initiatives still open (proposed, planned, active), active first. */
  initiatives: InitiativeCoverage[];
  active_initiatives: number;
  active_without_owner: number;
  /** Active projects with work planned or in progress. */
  projects: ProjectCoverage[];
  with_work: number;
  with_lead: number;
  /** Projects with work whose only lead is paused: counted as without a lead above. */
  with_lead_paused: number;
  /** What reaches no goal, from whole tables (computeUnplaced); absent when the caller read none. */
  unplaced?: OrgUnplaced;
  outside: {
    plans: Array<{ short_id: string; title: string; open_tasks: number }>;
    open_tasks: number;
    areas: Array<Pick<ActivityArea, "repository" | "path_prefix" | "commits_30d" | "sessions_30d">>;
  };
};

export const openPlanLine = (p: CoveragePlan): OpenPlanLine => ({
  short_id: p.short_id,
  title: p.title,
  status: p.status,
  progress: p.progress && p.progress.total > 0 ? { done: p.progress.done, total: p.progress.total } : null,
  last_activity_at: p.updated_at ?? p._creationTime ?? 0,
  driver: p.driver ?? null,
});

export const INITIATIVE_OPEN: ReadonlySet<string> = new Set(["active", "planned", "proposed"]);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

const INITIATIVE_DESCRIPTION_CHARS = 1500;
/** An entry of a record list is shown to be recognized, not read whole: enough of it to tell it is already there. */
const INITIATIVE_ENTRY_CHARS = 200;
export function computeCoverage(input: CoverageInputs): OrgCoverage {
  const openByProject = new Map<string, number>();
  const openByPlan = new Map<string, number>();
  let looseTasks = 0;
  for (const t of input.tasks) {
    if (!isOnProjectBoard(t) || t.status === "done") continue;
    if (t.project_id) bump(openByProject, String(t.project_id));
    if (t.plan_id) bump(openByPlan, String(t.plan_id));
    if (!t.project_id && !t.plan_id) looseTasks++;
  }
  const openPlansByProject = new Map<string, number>();
  for (const p of input.plans) if (p.project_id && !isClosedPlan(p.status)) bump(openPlansByProject, String(p.project_id));

  // A project the whole workspace role holds as the remainder (the rule's
  // `workspace` lead) is the list a lead is still missing for, so coverage
  // reads it as without one.
  const leadFacts = (project: CoverageProject): LeadFacts => {
    const lead = projectLeadOf(project, input.roles);
    if (lead.kind === "lead") {
      if (lead.by === "workspace") return {};
      return (lead.role as any).status === "paused" ? { lead_paused: `@${lead.role.handle}`, lead_by: lead.by } : { lead: `@${lead.role.handle}`, lead_by: lead.by };
    }
    return lead.kind === "watchers" ? { watchers: lead.roles.map((r) => `@${r.handle}`) } : {};
  };
  const hasWork = (p: CoverageProject) => p.status === "active" && ((openByProject.get(String(p._id)) ?? 0) > 0 || (openPlansByProject.get(String(p._id)) ?? 0) > 0);

  const open = input.initiatives.filter((i) => INITIATIVE_OPEN.has(i.status));
  const initiativesOf = new Map<string, string[]>();
  for (const i of open) for (const id of i.project_ids) initiativesOf.set(String(id), [...(initiativesOf.get(String(id)) ?? []), i.short_id]);

  const projects: ProjectCoverage[] = input.projects.filter(hasWork).map((p) => ({
    id: String(p._id),
    short_id: p.short_id ?? undefined,
    title: p.title,
    open_tasks: openByProject.get(String(p._id)) ?? 0,
    open_plans: openPlansByProject.get(String(p._id)) ?? 0,
    ...leadFacts(p),
    initiatives: initiativesOf.get(String(p._id)) ?? [],
  }));

  const projectById = new Map(input.projects.map((p) => [String(p._id), p]));
  const roleById = new Map(input.roles.map((r) => [String(r._id), r]));
  const shortOf = new Map(input.initiatives.map((i) => [String(i._id), i.short_id]));
  const byId = new Map(input.initiatives.map((i) => [String(i._id), i]));
  const ownerOf = (i: CoverageInitiative): InitiativeCoverage["owner"] => {
    if (i.owner?.kind === "role") {
      const role = roleById.get(String(i.owner.role_id));
      // A retired role drives nothing, the way it leads nothing.
      return role && role.status !== "retired" ? { kind: "role", handle: `@${role.handle}` } : undefined;
    }
    return i.owner ? { kind: "user", name: input.userNames?.[String(i.owner.user_id)] ?? "a person" } : undefined;
  };
  const rank = (s: string) => (s === "active" ? 0 : s === "planned" ? 1 : 2);
  const initiatives: InitiativeCoverage[] = [...open].sort((a, b) => rank(a.status) - rank(b.status)).map((i) => {
    const rows = i.project_ids.map((id) => projectById.get(String(id))).filter((p): p is CoverageProject => !!p)
      .map((p) => {
        const open = openPlansOf(input.plans, String(p._id));
        return { id: String(p._id), short_id: p.short_id ?? undefined, title: p.title, has_work: hasWork(p), ...leadFacts(p), open_plans: open.plans.map(openPlanLine), more_plans: open.more };
      });
    const words = (text: string | undefined, max = INITIATIVE_DESCRIPTION_CHARS) => (text?.trim() ? text.trim().slice(0, max) : undefined);
    const entry = (text: string | undefined) => words(text, INITIATIVE_ENTRY_CHARS) ?? "";
    const next = nextMilestone(i);
    const open = openQuestions(i);
    return {
      short_id: i.short_id,
      title: i.title,
      description: words(i.description),
      status: i.status,
      health: i.health,
      health_at: i.health_at,
      target_date: i.target_date,
      owner: ownerOf(i),
      parent: i.parent_initiative_id ? shortOf.get(String(i.parent_initiative_id)) : undefined,
      chain: initiativeChain(i, (id) => byId.get(id)),
      metrics: metricReadings(i),
      standing: initiativeStanding(metricReadings(i)),
      trends: Object.fromEntries(Object.entries(metricTrends(i)).map(([key, t]) => [key, trendWords(t)]).filter(([, said]) => said)),
      why: words(i.why),
      done_when: words(i.done_when),
      next_milestone: next ? { title: next.title, ...(next.date ? { date: next.date } : {}) } : undefined,
      milestones: orderedMilestones(i.milestones).map((m) => ({ title: entry(m.title), ...(m.date ? { date: m.date } : {}), ...(m.done_at ? { done: true as const } : {}) })),
      open_questions: open.map((q) => entry(q.text)),
      answered_questions: (i.questions ?? []).filter((q) => !open.includes(q)).map((q) => entry(q.text)),
      decisions: (i.decisions ?? []).map((d) => entry(d.text)),
      sources: (i.sources ?? []).map((s) => intentSourceAddress(s) || entry(s.quote)),
      projects: rows,
      projects_without_lead: rows.filter((p) => p.has_work && !p.lead).length,
    };
  });
  const active = initiatives.filter((i) => i.status === "active");

  return {
    initiatives,
    active_initiatives: active.length,
    active_without_owner: active.filter((i) => !i.owner).length,
    projects,
    with_work: projects.length,
    with_lead: projects.filter((p) => p.lead).length,
    with_lead_paused: projects.filter((p) => p.lead_paused).length,
    outside: {
      plans: input.plans.filter((p) => !p.project_id && !isClosedPlan(p.status) && (openByPlan.get(String(p._id)) ?? 0) > 0)
        .map((p) => ({ short_id: p.short_id, title: p.title, open_tasks: openByPlan.get(String(p._id))! })),
      open_tasks: looseTasks,
      // A path several projects share names none of them and is not outside any project either.
      areas: input.areas.filter((a) => !a.project_id && !a.project_shared_by && (a.commits_30d > 0 || a.sessions_30d > 0))
        .map(({ repository, path_prefix, commits_30d, sessions_30d }) => ({ repository, path_prefix, commits_30d, sessions_30d })),
    },
  };
}

// ── Unplaced work (ct-95900) ────────────────────────────────────────────────
// What reaches no goal, read bottom-up from whole tables rather than from the
// capped task sample: an open plan with no project, an active project with
// open work that no open goal carries, the week's open tasks filed under
// neither a plan nor a project (grouped by the session that made them), and a
// session running a week or more whose bound work reaches no goal. Each item
// says how old it is, when it last moved and which session drives it, so the
// Head of People can place it or ask its driver. The reads are the caller's
// (orgUnplaced.readUnplaced); this is the pure reading over what they found.

const DAY_MS = 86_400_000;
/** A session counts as long running from this age (the analyzer's long_running bar). */
export const UNPLACED_SESSION_MIN_AGE_MS = 7 * DAY_MS;
/** The window loose tasks and long running sessions must have moved in. */
export const UNPLACED_RECENT_MS = 7 * DAY_MS;
/** An open plan with no open task is listed only while it moved this recently: an old empty draft is not work in flight. */
export const UNPLACED_EMPTY_PLAN_MS = 30 * DAY_MS;
export const UNPLACED_CAPS = { plans: 40, projects: 40, task_groups: 15, task_examples: 4, sessions: 20 } as const;

export type UnplacedPlan = { short_id: string; title: string; status: string; open_tasks: number; done_tasks: number; created_at: number; age_days: number; last_activity_at: number; driver: SessionRef | null };
export type UnplacedProject = { short_id?: string; title: string; open_tasks: number; open_plans: number; lead: string | null; created_at: number; age_days: number; last_activity_at: number; driver: SessionRef | null };
export type UnplacedTaskGroup = { session: SessionRef | null; tasks: number; examples: Array<{ short_id: string; title: string }>; age_days: number; last_activity_at: number };
export type UnplacedSession = { short_id: string; title: string; owner?: string; started_at: number; age_days: number; last_activity_at: number; bound: Array<{ kind: "task" | "plan"; short_id: string; title: string }>; reason: "no project" | "project with no goal" };
export type OrgUnplaced = {
  plans: UnplacedPlan[];
  projects: UnplacedProject[];
  loose_tasks: { total: number; by_session: UnplacedTaskGroup[] };
  sessions: UnplacedSession[];
  /** A list hit its cap or a read hit its limit: the lists are a floor. */
  truncated: boolean;
};

export type UnplacedInputs = {
  now: number;
  /** Open plans with no project, each with its tasks counted from an index read. */
  plans: Array<{ short_id: string; title: string; status: string; created_at: number; updated_at: number; tasks: { open: number; done: number; last_at: number | null }; driver: SessionRef | null }>;
  /** Active projects with open work, each with whether an open goal carries it. */
  projects: Array<{ short_id?: string; title: string; status: string; created_at: number; updated_at: number; open_tasks: number; open_plans: number; lead: string | null; has_goal: boolean; last_at: number | null; driver: SessionRef | null }>;
  /** Open tasks touched in the window with neither plan nor project. */
  loose_tasks: Array<{ short_id: string; title: string; created_at: number; updated_at: number; session: SessionRef | null }>;
  /** Sessions with bound work, and whether each bound record reaches an open goal. */
  sessions: Array<{ short_id: string; title: string; owner?: string; started_at: number; updated_at: number; bound: Array<{ kind: "task" | "plan"; short_id: string; title: string; project: string | null; reaches_goal: boolean }> }>;
  truncated?: boolean;
};

const ageDays = (now: number, at: number) => Math.max(0, Math.floor((now - at) / DAY_MS));

export function computeUnplaced(input: UnplacedInputs): OrgUnplaced {
  const { now } = input;
  let truncated = !!input.truncated;
  const capped = <T>(rows: T[], cap: number): T[] => { if (rows.length > cap) truncated = true; return rows.slice(0, cap); };
  const newest = <T extends { last_activity_at: number }>(a: T, b: T) => b.last_activity_at - a.last_activity_at;

  const plans: UnplacedPlan[] = input.plans
    .map((p) => ({ p, last: Math.max(p.updated_at, p.tasks.last_at ?? 0) }))
    .filter(({ p, last }) => isOpenStatus(p.status) && (p.tasks.open > 0 || now - last < UNPLACED_EMPTY_PLAN_MS))
    .map(({ p, last }) => ({ short_id: p.short_id, title: p.title, status: p.status, open_tasks: p.tasks.open, done_tasks: p.tasks.done, created_at: p.created_at, age_days: ageDays(now, p.created_at), last_activity_at: last, driver: p.driver }))
    .sort(newest);

  const projects: UnplacedProject[] = input.projects
    .filter((p) => p.status === "active" && !p.has_goal && (p.open_tasks > 0 || p.open_plans > 0))
    .map((p) => ({ short_id: p.short_id, title: p.title, open_tasks: p.open_tasks, open_plans: p.open_plans, lead: p.lead, created_at: p.created_at, age_days: ageDays(now, p.created_at), last_activity_at: Math.max(p.updated_at, p.last_at ?? 0), driver: p.driver }))
    .sort(newest);

  const groups = new Map<string, { session: SessionRef | null; rows: UnplacedInputs["loose_tasks"] }>();
  for (const t of input.loose_tasks) {
    if (now - t.updated_at >= UNPLACED_RECENT_MS) continue;
    const key = t.session?.short_id ?? "";
    const g = groups.get(key) ?? { session: t.session, rows: [] };
    g.rows.push(t);
    groups.set(key, g);
  }
  const by_session: UnplacedTaskGroup[] = Array.from(groups.values()).map(({ session, rows }) => {
    const byNew = [...rows].sort((a, b) => b.updated_at - a.updated_at);
    return {
      session,
      tasks: rows.length,
      examples: byNew.slice(0, UNPLACED_CAPS.task_examples).map((t) => ({ short_id: t.short_id, title: t.title })),
      age_days: ageDays(now, Math.min(...rows.map((t) => t.created_at))),
      last_activity_at: byNew[0].updated_at,
    };
  }).sort((a, b) => b.tasks - a.tasks || b.last_activity_at - a.last_activity_at);
  const looseTotal = by_session.reduce((n, g) => n + g.tasks, 0);

  const sessions: UnplacedSession[] = input.sessions
    .filter((s) => now - s.started_at >= UNPLACED_SESSION_MIN_AGE_MS && now - s.updated_at < UNPLACED_RECENT_MS && s.bound.length > 0 && !s.bound.some((b) => b.reaches_goal))
    .map((s) => ({
      short_id: s.short_id, title: s.title, ...(s.owner ? { owner: s.owner } : {}), started_at: s.started_at, age_days: ageDays(now, s.started_at), last_activity_at: s.updated_at,
      bound: s.bound.map(({ kind, short_id, title }) => ({ kind, short_id, title })),
      reason: s.bound.some((b) => b.project) ? "project with no goal" as const : "no project" as const,
    }))
    .sort(newest);

  return {
    plans: capped(plans, UNPLACED_CAPS.plans),
    projects: capped(projects, UNPLACED_CAPS.projects),
    loose_tasks: { total: looseTotal, by_session: capped(by_session, UNPLACED_CAPS.task_groups) },
    sessions: capped(sessions, UNPLACED_CAPS.sessions),
    truncated,
  };
}
const isOpenStatus = (s: string) => !isClosedPlan(s);

/** Coverage with the unplaced reading beside it. `outside.plans` is then
 *  read from it: its open task counts come from an index read per plan, where
 *  the sample missed a plan whose open tasks fell outside the capped read
 *  (Union pl-1043 and pl-792, 2026-11-17). */
export function withUnplaced(c: OrgCoverage, unplaced: OrgUnplaced | null | undefined): OrgCoverage {
  if (!unplaced) return c;
  return { ...c, unplaced, outside: { ...c.outside, plans: unplaced.plans.filter((p) => p.open_tasks > 0).map((p) => ({ short_id: p.short_id, title: p.title, open_tasks: p.open_tasks })) } };
}
