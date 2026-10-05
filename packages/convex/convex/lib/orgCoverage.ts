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
import { initiativeChain, initiativeStanding, metricReadings, metricTrends, nextMilestone, openQuestions, trendWords, type InitiativeLink, type InitiativeRow, type MetricReading, type MetricStanding } from "@codecast/shared/contracts/initiative";
import { isOnProjectBoard } from "@codecast/shared/tasks";
import { isClosedPlan, type ActivityArea } from "./orgActivity";

export type CoverageRole = LeadRole & { handle: string };
export type CoverageProject = { _id: unknown; short_id?: string | null; title: string; status?: string; owner_role_id?: unknown };
export type CoveragePlan = { _id: unknown; short_id: string; title: string; status: string; project_id?: unknown };
/** The fields the board rule reads, beside the two links; a raw task row satisfies it. */
export type CoverageTask = Parameters<typeof isOnProjectBoard>[0] & { status?: string | null; project_id?: unknown; plan_id?: unknown };
export type CoverageInitiative = Pick<InitiativeRow, "_id" | "short_id" | "title" | "status" | "owner" | "health" | "health_at" | "target_date" | "project_ids" | "parent_initiative_id" | "metrics" | "scoreboard" | "description" | "score_history" | "why" | "done_when" | "milestones" | "questions" | "sources">;

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
  /** Against the numbers: behind if any metric is, met if every reported one is, else unknown. The owner's `health` is their word; this is the target's. */
  standing: MetricStanding;
  /** Which way each metric is moving, by metric key, in words ("up from 380, toward the target"); a metric with fewer than two reports has no entry. */
  trends: Record<string, string>;
  // The intent record (I5), as much of it as a review reads to say what the goal still lacks.
  /** Why it matters, in its author's words. */
  why?: string;
  /** What done looks like: the sentence a result is checked against. */
  done_when?: string;
  /** The first milestone not reached, earliest day first; absent when every one is reached or none is set. */
  next_milestone?: { title: string; date?: number };
  /** What is still undecided, as asked. */
  open_questions: string[];
  /** How many sources say where the goal was stated; none means nobody can check who said it. */
  sources: number;
  projects: Array<LeadFacts & { id: string; short_id?: string; title: string; has_work: boolean }>;
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
  outside: {
    plans: Array<{ short_id: string; title: string; open_tasks: number }>;
    open_tasks: number;
    areas: Array<Pick<ActivityArea, "repository" | "path_prefix" | "commits_30d" | "sessions_30d">>;
  };
};

const INITIATIVE_OPEN: ReadonlySet<string> = new Set(["active", "planned", "proposed"]);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

const INITIATIVE_DESCRIPTION_CHARS = 1500;
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
      .map((p) => ({ id: String(p._id), short_id: p.short_id ?? undefined, title: p.title, has_work: hasWork(p), ...leadFacts(p) }));
    const words = (text: string | undefined) => (text?.trim() ? text.trim().slice(0, INITIATIVE_DESCRIPTION_CHARS) : undefined);
    const next = nextMilestone(i);
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
      open_questions: openQuestions(i).map((q) => q.text),
      sources: i.sources?.length ?? 0,
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
