// What a role's area feeds (initiatives-projects-role-page.md I4): the open
// initiatives it owns, and the ones its projects carry, each read against its
// metrics and placed under the goal it feeds up to the top level. One reading
// for the role card in every wake (agentTasks.roleCardOf), the health panel's
// area row (orgHealth) and the scope view, so a role and the person watching
// it see the same chain and the same numbers.
import { INITIATIVE_STATUSES, initiativeChain, metricReadings, type InitiativeLink, type InitiativeRow, type MetricReading } from "@codecast/shared/contracts/initiative";

export type ServedInitiative = {
  _id: string;
  short_id: string;
  title: string;
  status: InitiativeRow["status"];
  health: InitiativeRow["health"];
  /** The role owns it, as against carrying one of its projects. */
  owned: boolean;
  metrics: MetricReading[];
  /** The goals above it, nearest first, up to the top level goal. */
  chain: InitiativeLink[];
};

const OPEN = new Set<InitiativeRow["status"]>(INITIATIVE_STATUSES.filter((s) => s !== "completed" && s !== "cancelled"));
export const SERVED_INITIATIVES_READ = 200;
export const SERVED_INITIATIVES_MAX = 4;

/** The initiatives a set of rows says an area serves, owned ones first, then by status (active first), then by short id. */
export function servedInitiatives(rows: InitiativeRow[], area: { role_id?: string; project_ids: Iterable<string> }, max = SERVED_INITIATIVES_MAX): ServedInitiative[] {
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const projects = new Set(Array.from(area.project_ids, String));
  const rank = (s: InitiativeRow["status"]) => (s === "active" ? 0 : s === "planned" ? 1 : 2);
  return rows
    .filter((r) => OPEN.has(r.status))
    .map((r) => ({ r, owned: !!area.role_id && r.owner?.kind === "role" && String(r.owner.role_id) === String(area.role_id), carries: r.project_ids.some((p) => projects.has(String(p))) }))
    .filter((x) => x.owned || x.carries)
    .sort((a, b) => Number(b.owned) - Number(a.owned) || rank(a.r.status) - rank(b.r.status) || a.r.short_id.localeCompare(b.r.short_id, undefined, { numeric: true }))
    .slice(0, max)
    .map(({ r, owned }) => ({ _id: String(r._id), short_id: r.short_id, title: r.title, status: r.status, health: r.health, owned, metrics: metricReadings(r), chain: initiativeChain(r, (id) => byId.get(id)) }));
}

/** The workspace's initiatives, one bounded read by access key. */
export async function readWorkspaceInitiatives(ctx: { db: any }, workspace: string): Promise<InitiativeRow[]> {
  return ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(SERVED_INITIATIVES_READ);
}

/** The initiatives a role serves, read fresh: its workspace is its team's or its own person's. */
export async function roleServedInitiatives(ctx: { db: any }, role: { _id: any; team_id?: any; scope_user_id?: any; host_user_id?: any; scope?: { project_ids?: any[] } }): Promise<ServedInitiative[]> {
  const workspace = role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id ?? role.host_user_id}`;
  return servedInitiatives(await readWorkspaceInitiatives(ctx, workspace), { role_id: String(role._id), project_ids: (role.scope?.project_ids ?? []).map(String) });
}
