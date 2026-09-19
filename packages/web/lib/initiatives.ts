// What an initiative's surfaces derive at render
// (docs/architecture/initiatives-projects-role-page.md I1). The synced row is
// raw; everything beside it is computed here from the store's collections:
// progress (tasks done over tasks in its projects), the projects' own trouble
// beside the owner's word, sub initiatives, whose conversation the page opens
// beside, and the one initiative a task or a project reads as. Pure, so a task's status change
// moves every bar in the same tick and nothing derived is ever stored.
import type { InitiativeOwner, InitiativeRow, InitiativeStatus } from "@codecast/shared/contracts/initiative";
import type { OrgRole, OrgTree } from "../components/org/orgTypes";
import { computePlanProgress } from "./liveEntities";
import { scopeSeatOf } from "./scopePage";

export type Progress = ReturnType<typeof computePlanProgress>;
type TaskLike = { _id: string; status?: string; project_id?: string | null; plan_id?: string | null };
type PlanLike = { _id: string; short_id: string; title: string; status: string; project_id?: string | null };
type ProjectLike = { _id: string; title: string; status: string; target_date?: number; risks?: string[] };

/** The list's order: what is being driven now, then what is coming, then what ended. */
export const INITIATIVE_STATUS_ORDER: readonly InitiativeStatus[] = ["active", "planned", "proposed", "completed", "cancelled"];
const statusRank = (s: InitiativeStatus) => INITIATIVE_STATUS_ORDER.indexOf(s);

/** The id `resolveAssigneeInfo` takes: a role's or a person's, whichever owns it. */
export const ownerId = (owner: InitiativeOwner | undefined): string | null =>
  !owner ? null : owner.kind === "role" ? owner.role_id : owner.user_id;

/** Tasks bucketed by project once, so every rollup on a page is a lookup. A
 *  task with no project of its own counts under its plan's project, the rule
 *  the scope view reads by (lib/roleScope), so an initiative's bar and its
 *  project cards always agree. */
export function tasksByProject<T extends TaskLike>(tasks: readonly T[], plans: readonly Pick<PlanLike, "_id" | "project_id">[] = []): Map<string, T[]> {
  const planProject = new Map(plans.map((p) => [p._id, p.project_id ?? null]));
  const out = new Map<string, T[]>();
  for (const t of tasks) {
    const pid = t.project_id ?? (t.plan_id ? planProject.get(t.plan_id) ?? null : null);
    if (!pid) continue;
    const bucket = out.get(pid);
    if (bucket) bucket.push(t); else out.set(pid, [t]);
  }
  return out;
}

/** Tasks done over tasks in the initiative's projects. A task has one project
 *  and `project_ids` holds each project once, so no task counts twice. */
export function initiativeProgress(initiative: Pick<InitiativeRow, "project_ids">, byProject: Map<string, TaskLike[]>): Progress {
  return computePlanProgress(initiative.project_ids.flatMap((id) => byProject.get(id) ?? []));
}

export const progressPercent = (p: Progress): number => (p.total === 0 ? 0 : Math.round((p.done / p.total) * 100));

/** What a project says for itself, shown beside the owner's word so the two
 *  can disagree in plain sight: it is past its target with work left, or its
 *  lead wrote risks into its charter. */
export function projectTrouble(project: ProjectLike, counts: { open: number; done: number }, now: number): string | null {
  const unfinished = counts.open > 0 || counts.done === 0;
  if (project.target_date && project.target_date < now && unfinished && project.status !== "done") return "past its target";
  const risks = project.risks?.filter((r) => r.trim()).length ?? 0;
  return risks > 0 ? `${risks} ${risks === 1 ? "risk" : "risks"} in its charter` : null;
}

export const subInitiatives = (rows: readonly InitiativeRow[], parentId: string): InitiativeRow[] =>
  rows.filter((r) => r.parent_initiative_id === parentId).sort(byListOrder);

/** A row whose parent the viewer can see nests under it; one whose parent is
 *  missing (another workspace, no access) stands at the top level. */
export function topLevelInitiatives(rows: readonly InitiativeRow[]): InitiativeRow[] {
  const ids = new Set(rows.map((r) => r._id));
  return rows.filter((r) => !r.parent_initiative_id || !ids.has(r.parent_initiative_id));
}

/** The one order every surface lists initiatives in: what is being driven now,
 *  then the nearest target, then the oldest. */
export function byListOrder(a: InitiativeRow, b: InitiativeRow): number {
  return statusRank(a.status) - statusRank(b.status)
    || (a.target_date ?? Infinity) - (b.target_date ?? Infinity)
    || a.created_at - b.created_at;
}

export function groupInitiativesByStatus(rows: readonly InitiativeRow[]): { status: InitiativeStatus; rows: InitiativeRow[] }[] {
  const top = [...topLevelInitiatives(rows)].sort(byListOrder);
  return INITIATIVE_STATUS_ORDER
    .map((status) => ({ status, rows: top.filter((r) => r.status === status) }))
    .filter((g) => g.rows.length > 0);
}

/** Every initiative a project belongs to, the ones still open first. */
export const initiativesOfProject = (rows: readonly InitiativeRow[], projectId: string): InitiativeRow[] =>
  rows.filter((r) => r.project_ids.includes(projectId)).sort(byListOrder);

/** A project may sit in several initiatives, and a task board needs one
 *  bucket for each task. The one a project reads as is the first by the list's
 *  order: an open initiative before a closed one, then the nearest target. */
export function projectInitiativeIndex(rows: readonly InitiativeRow[]): Map<string, InitiativeRow> {
  const out = new Map<string, InitiativeRow>();
  for (const row of [...rows].sort(byListOrder)) {
    for (const id of row.project_ids) if (!out.has(id)) out.set(id, row);
  }
  return out;
}

/** The wake signature of the rows a list paints: a heartbeat on `updated_at`
 *  alone changes nothing a person reads, so it is left out. */
export const initiativeSig = (r: InitiativeRow): string =>
  [r._id, r.short_id, r.title, r.status, r.health, r.health_at ?? "", r.target_date ?? "", ownerId(r.owner) ?? "", r.priority ?? "", r.parent_initiative_id ?? "", r.project_ids.join(","), r.description ?? ""].join("|");

/** The key a create or an update stub is born with, and the server row
 *  carries back: never a Convex id, so nothing mistakes the stub for a row. */
export const newInitiativeKey = (): string => `in_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** The address of an initiative's page: its `in-N`, or its key while it is a stub. */
export const initiativeHref = (r: Pick<InitiativeRow, "_id" | "short_id">): string => `/initiatives/${r.short_id || r._id}`;

/** The conversation an initiative opens beside (I1 "The page"): a role
 *  owner's standing session, or a person owner's own anchor in this workspace.
 *  Null when nobody drives it, or the person keeps no anchor here; the page
 *  then shows the initiative alone. */
export function ownerSeat(tree: OrgTree | null, owner: InitiativeOwner | undefined): { role: OrgRole | null; conversationId: string | null; speaker: string | null } {
  if (!tree || !owner) return { role: null, conversationId: null, speaker: null };
  if (owner.kind === "role") {
    const { role, anchor } = scopeSeatOf(tree, owner.role_id);
    return { role, conversationId: role?.standing?.conversation_id ?? anchor?.conversation_id ?? null, speaker: role?.name ?? null };
  }
  // A person's anchor: one they host that no role holds, else the workspace's
  // root seat when they host it (org-staffing.md S16: the root agent is the
  // chief of staff once seated, and it answers to its host).
  const own = tree.anchors.find((a) => !a.org_role_id && a.host_user_id === owner.user_id);
  const root = own ? null : scopeSeatOf(tree, "workspace").anchor;
  const anchor = own ?? (root && root.host_user_id === owner.user_id ? root : null);
  return { role: null, conversationId: anchor?.conversation_id ?? null, speaker: anchor?.name ?? null };
}
