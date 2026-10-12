// The Everything chart's product layer, resolved for the people tree
// (orgLayout.OrgProductInput): the org is the spine and the goals and
// projects join it. A goal hangs under the person or role that owns it; a
// project under the role that leads it, with the sessions working on it under
// the project; each project names the goals it serves. What nobody owns or
// leads goes to one "No owner yet" group, and the mission (or the company)
// sits at the top. Pure: the cards' heights come from goalsLayout's own sizing
// for the zoom level, and their data is what GoalsNodeCards already draws.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { metricReadings } from "@codecast/shared/contracts/initiative";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { goalCloseExtra, goalFarHeight, goalHeight, goalsPlan, GOALS_SIZES, type GoalOwner, type GoalProject, type PlanGoal, type PlanProject } from "./goalsLayout";
import type { OrgProductInput } from "./orgLayout";
import { CARD } from "./orgCardModel";
import { countStates, type OrgParentRef, type OrgSession, type OrgTree } from "./orgTypes";
import type { ZoomLevel } from "./orgZoom";

export type OrgProductSource = {
  initiatives: readonly InitiativeRow[];
  projects: readonly GoalProject[];
  /** Which project a session works on, from the store (useOrgPeopleView). */
  sessionProject: Readonly<Record<string, string>>;
};

const CLOSED = new Set(["done", "archived", "cancelled", "completed"]);
const refOf = (o: GoalOwner | null): OrgParentRef | null => (o?.kind === "person" ? { kind: "user", user_id: o.id } : o?.kind === "role" ? { kind: "role", role_id: o.id } : null);

export function productLayer(tree: OrgTree, src: OrgProductSource, level: ZoomLevel): OrgProductInput {
  const S = GOALS_SIZES;
  const far = level === "far";
  const close = level === "close";
  const { goals } = goalsPlan({ tree, initiatives: src.initiatives, projects: src.projects });
  const kids = new Map<string | null, PlanGoal[]>();
  for (const g of goals) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g]);
  const top = kids.get(null) ?? [];
  // One top level goal that other goals feed is the mission: it sits at the top, wearing the company's name.
  const root = top.length === 1 && (kids.get(top[0].id)?.length ?? 0) > 0 ? top[0] : null;
  const live = src.projects.filter((p) => !CLOSED.has(p.status ?? ""));
  const companyName = tree.workspace.name || (tree.workspace.kind === "user" ? "Personal" : "Company");
  const goalCard = (g: PlanGoal, mission: boolean, rootInfo?: { name: string; goals: number; projects: number }) => {
    const metrics = g.row ? metricReadings(g.row) : [];
    const h = far ? goalFarHeight(g.title, mission) : goalHeight(g, metrics.length > 0, 0, mission) + (close ? goalCloseExtra(g, metrics.length, 0) : 0);
    return { h, w: rootInfo ? S.company.w : S.goal.w, data: { goal: g, metrics, rows: [], refs: [], running: [], mission, hasChildren: (kids.get(g.id)?.length ?? 0) > 0, ...(rootInfo ? { root: rootInfo } : {}) } };
  };
  const rootCard = root ? goalCard(root, true, { name: companyName, goals: goals.length - 1, projects: live.length }) : null;
  const mission = rootCard
    ? { ...rootCard, data: { ...rootCard.data, card: "goal" } }
    : goals.length || live.length ? { h: S.company.h, w: S.company.w, data: { card: "company", name: companyName, goals: goals.length, projects: live.length, mission: false } } : null;

  // Every session the tree holds, to count each project's by state.
  const sessions = new Map<string, OrgSession>();
  for (const b of [...tree.people, ...tree.roles]) for (const s of b.sessions) sessions.set(s._id, s);
  const byProject = new Map<string, OrgSession[]>();
  for (const [sid, pid] of Object.entries(src.sessionProject)) { const s = sessions.get(sid); if (s) byProject.set(pid, [...(byProject.get(pid) ?? []), s]); }

  const servedBy = new Map<string, { id: string; title: string }[]>();
  for (const g of goals) for (const p of g.projects) servedBy.set(p.id, [...(servedBy.get(p.id) ?? []), { id: g.id, title: g.title }]);
  const projects = live.map((p) => {
    const lead = projectLeadOf(p, tree.roles);
    const owner: GoalOwner | null = lead?.kind === "lead" && lead.by !== "workspace" ? { kind: "role", id: lead.role._id, name: lead.role.name, handle: lead.role.handle, avatar: lead.role.avatar } : null;
    const serves = servedBy.get(p._id) ?? [];
    const list = byProject.get(p._id) ?? [];
    const project: PlanProject = { id: p._id, title: p.title, short_id: p.short_id, status: p.status, lead: owner };
    const h = S.project.h + (close ? S.projectClose : 0) + (serves.length && !far ? S.projectGoalsRow : 0);
    return { id: p._id, lead: refOf(owner), goalIds: serves.map((g) => g.id), h, w: CARD.session.w, data: { project, goals: serves, ...(list.length ? { counts: countStates(list) } : {}) } };
  });
  return {
    mission,
    goals: goals.filter((g) => g !== root).map((g) => ({ id: g.id, owner: refOf(g.owner), ...goalCard(g, false) })),
    projects,
    sessionProject: src.sessionProject,
  };
}
