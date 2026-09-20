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
// split a lead is the analyzer's reading (ORG_COVERAGE_RULE).

import { projectLeadOf, type LeadRole } from "@codecast/shared/contracts/orgLead";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { isOnProjectBoard } from "@codecast/shared/tasks";
import { isClosedPlan, type ActivityArea } from "./orgActivity";

export type CoverageRole = LeadRole & { handle: string };
export type CoverageProject = { _id: unknown; short_id?: string | null; title: string; status?: string; owner_role_id?: unknown };
export type CoveragePlan = { _id: unknown; short_id: string; title: string; status: string; project_id?: unknown };
/** The fields the board rule reads, beside the two links; a raw task row satisfies it. */
export type CoverageTask = Parameters<typeof isOnProjectBoard>[0] & { status?: string | null; project_id?: unknown; plan_id?: unknown };
export type CoverageInitiative = Pick<InitiativeRow, "_id" | "short_id" | "title" | "status" | "owner" | "health" | "health_at" | "target_date" | "project_ids" | "parent_initiative_id">;

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
type LeadFacts = { lead?: string; lead_by?: "owner" | "scope"; watchers?: string[] };

export type ProjectCoverage = LeadFacts & { id: string; short_id?: string; title: string; open_tasks: number; open_plans: number; initiatives: string[] };

export type InitiativeCoverage = {
  short_id: string;
  title: string;
  status: InitiativeRow["status"];
  health: InitiativeRow["health"];
  health_at?: number;
  target_date?: number;
  /** Absent means nobody drives it. */
  owner?: { kind: "role"; handle: string } | { kind: "user"; name: string };
  parent?: string;
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
  outside: {
    plans: Array<{ short_id: string; title: string; open_tasks: number }>;
    open_tasks: number;
    areas: Array<Pick<ActivityArea, "repository" | "path_prefix" | "commits_30d" | "sessions_30d">>;
  };
};

const INITIATIVE_OPEN: ReadonlySet<string> = new Set(["active", "planned", "proposed"]);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

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

  const leadFacts = (project: CoverageProject): LeadFacts => {
    const lead = projectLeadOf(project, input.roles);
    if (lead.kind === "lead") return { lead: `@${lead.role.handle}`, lead_by: lead.by };
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
    return {
      short_id: i.short_id,
      title: i.title,
      status: i.status,
      health: i.health,
      health_at: i.health_at,
      target_date: i.target_date,
      owner: ownerOf(i),
      parent: i.parent_initiative_id ? shortOf.get(String(i.parent_initiative_id)) : undefined,
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
    outside: {
      plans: input.plans.filter((p) => !p.project_id && !isClosedPlan(p.status) && (openByPlan.get(String(p._id)) ?? 0) > 0)
        .map((p) => ({ short_id: p.short_id, title: p.title, open_tasks: openByPlan.get(String(p._id))! })),
      open_tasks: looseTasks,
      areas: input.areas.filter((a) => !a.project_id && (a.commits_30d > 0 || a.sessions_30d > 0))
        .map(({ repository, path_prefix, commits_30d, sessions_30d }) => ({ repository, path_prefix, commits_30d, sessions_30d })),
    },
  };
}
