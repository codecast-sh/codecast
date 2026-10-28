// What a role's area feeds (initiatives-projects-role-page.md I4): the open
// initiatives it owns, and the ones its projects carry, each read against its
// metrics and placed under the goal it feeds up to the top level. One reading
// for the role card in every wake (agentTasks.roleCardOf), the health panel's
// area row (orgHealth) and the scope view, so a role and the person watching
// it see the same chain and the same numbers.
import { INITIATIVE_STATUSES, initiativeChain, metricLine, metricReadings, metricTrends, paceWords, type InitiativeLink, type InitiativeMetric, type InitiativeRow, type MetricReading, type MetricSeries, type MetricTrend } from "@codecast/shared/contracts/initiative";
import { seriesLookup } from "./metricSeries";

export type ServedInitiative = {
  _id: string;
  short_id: string;
  title: string;
  status: InitiativeRow["status"];
  health: InitiativeRow["health"];
  /** When the health was last said (the latest update), or null before one. */
  health_at: number | null;
  /** The role owns it, as against carrying one of its projects. */
  owned: boolean;
  metrics: MetricReading[];
  /** Each metric's trend by key: its live series' last week, else its reports. */
  trends: Record<string, MetricTrend>;
  target_date: number | null;
  /** The goals above it, nearest first, up to the top level goal. */
  chain: InitiativeLink[];
};

/** A served goal's numbers in the words a role reads them: value against target, the trend, live or reported, and the pace a goal behind its date needs. */
export function servedMetricLines(i: Pick<ServedInitiative, "metrics" | "trends" | "target_date">, now = Date.now()): string[] {
  return i.metrics.map((m) => {
    const pace = m.guardrail ? "" : paceWords(m, i.trends[m.key], i.target_date, now);
    return `${metricLine(m, now, i.trends[m.key])}${pace ? `; ${pace}` : ""}`;
  });
}


const OPEN = new Set<InitiativeRow["status"]>(INITIATIVE_STATUSES.filter((s) => s !== "completed" && s !== "cancelled"));
export const SERVED_INITIATIVES_READ = 200;
export const SERVED_INITIATIVES_MAX = 4;

/** The initiatives a set of rows says an area serves, owned ones first, then by status (active first), then by short id. */
export function servedInitiatives(rows: InitiativeRow[], area: { role_id?: string; project_ids: Iterable<string> }, max = SERVED_INITIATIVES_MAX, series?: (ref: string) => MetricSeries | undefined): ServedInitiative[] {
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const projects = new Set(Array.from(area.project_ids, String));
  const rank = (s: InitiativeRow["status"]) => (s === "active" ? 0 : s === "planned" ? 1 : 2);
  return rows
    .filter((r) => OPEN.has(r.status))
    .map((r) => ({ r, owned: !!area.role_id && r.owner?.kind === "role" && String(r.owner.role_id) === String(area.role_id), carries: r.project_ids.some((p) => projects.has(String(p))) }))
    .filter((x) => x.owned || x.carries)
    .sort((a, b) => Number(b.owned) - Number(a.owned) || rank(a.r.status) - rank(b.r.status) || a.r.short_id.localeCompare(b.r.short_id, undefined, { numeric: true }))
    .slice(0, max)
    .map(({ r, owned }) => ({ _id: String(r._id), short_id: r.short_id, title: r.title, status: r.status, health: r.health, health_at: r.health_at ?? null, owned, metrics: metricReadings(r, series), trends: metricTrends(r, series), target_date: r.target_date ?? null, chain: initiativeChain(r, (id) => byId.get(id)) }));
}

/** The workspace's initiatives, one bounded read by access key. */
export async function readWorkspaceInitiatives(ctx: { db: any }, workspace: string): Promise<InitiativeRow[]> {
  return ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(SERVED_INITIATIVES_READ);
}

/** The initiatives a role serves, read fresh: its workspace is its team's or its own person's. */
export async function roleServedInitiatives(ctx: { db: any }, role: { _id: any; team_id?: any; scope_user_id?: any; host_user_id?: any; scope?: { project_ids?: any[] } }): Promise<ServedInitiative[]> {
  const workspace = roleWorkspace(role);
  const rows = await readWorkspaceInitiatives(ctx, workspace);
  return servedInitiatives(rows, { role_id: String(role._id), project_ids: (role.scope?.project_ids ?? []).map(String) }, SERVED_INITIATIVES_MAX, await seriesLookup(ctx, workspace, rows));
}

const roleWorkspace = (role: { team_id?: any; scope_user_id?: any; host_user_id?: any }) => (role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id ?? role.host_user_id}`);

export type ProjectNumbers = { short_id: string; title: string; metrics: MetricReading[]; trends: Record<string, MetricTrend>; target_date: number | null };

/** The numbers of the projects a role looks after, each read from its live series, for the projects that carry any. */
export async function roleProjectNumbers(ctx: { db: any }, role: { team_id?: any; scope_user_id?: any; host_user_id?: any; scope?: { project_ids?: any[] } }): Promise<ProjectNumbers[]> {
  const projects: Array<{ short_id?: string; _id: any; title: string; metrics?: InitiativeMetric[]; target_date?: number; workspace?: string }> = (await Promise.all((role.scope?.project_ids ?? []).map((id: any) => ctx.db.get(id)))).filter((p: any) => p?.metrics?.length);
  if (!projects.length) return [];
  const series = await seriesLookup(ctx, roleWorkspace(role), projects);
  return projects.map((p) => ({ short_id: p.short_id ?? String(p._id), title: p.title, metrics: metricReadings(p, series), trends: metricTrends(p, series), target_date: p.target_date ?? null }));
}
