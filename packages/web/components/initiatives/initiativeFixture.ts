// A typed fixture of the contract's rows
// (docs/architecture/initiatives-projects-role-page.md I1;
// @codecast/shared/contracts/initiative). The mount tests and the derivation
// tests read it. It carries one initiative owned by a role and one by a
// person, a sub initiative, a project that sits in two initiatives, and an
// initiative nobody owns.
import type { InitiativeRow, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";

const DAY = 86_400_000;
export const FIXTURE_NOW = Date.UTC(2026, 8, 18, 12);
const WS = "team:fixture-team";

const row = (r: Partial<InitiativeRow> & Pick<InitiativeRow, "_id" | "short_id" | "title" | "status">): InitiativeRow => ({
  project_ids: [], health: "none", workspace: WS, team_id: "fixture-team", user_id: "fixture-user-me",
  created_at: FIXTURE_NOW - 30 * DAY, updated_at: FIXTURE_NOW - DAY, ...r,
});

export const FIXTURE_PROJECTS = [
  { _id: "proj-org", title: "Agent org", status: "active", workspace: WS, owner_role_id: "fixture-role-growth", target_date: FIXTURE_NOW + 40 * DAY, task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 1, doc_count: 0, active_plan_count: 1, created_at: 0, updated_at: 0 },
  { _id: "proj-inbox", title: "Inbox", status: "active", workspace: WS, target_date: FIXTURE_NOW - 3 * DAY, task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, active_plan_count: 0, created_at: 0, updated_at: 0 },
  { _id: "proj-billing", title: "Billing", status: "active", workspace: WS, risks: ["Stripe migration has no owner"], task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, active_plan_count: 0, created_at: 0, updated_at: 0 },
];

export const FIXTURE_PLANS = [
  { _id: "plan-roles", short_id: "pl-715", title: "Initiatives and the role page", status: "active", source: "cli", project_id: "proj-org", workspace: WS, created_at: 0, updated_at: 0 },
  { _id: "plan-old", short_id: "pl-600", title: "Org chart v1", status: "done", source: "cli", project_id: "proj-org", workspace: WS, created_at: 0, updated_at: 0 },
];

const task = (id: string, project_id: string, status: string, plan_id?: string) => ({ _id: id, short_id: `ct-${id}`, title: `Task ${id}`, status, project_id, plan_id, source: "human", workspace: WS, created_at: 0, updated_at: 0 });
export const FIXTURE_TASKS = [
  task("1", "proj-org", "done", "plan-roles"), task("2", "proj-org", "done", "plan-roles"), task("3", "proj-org", "in_progress", "plan-roles"), task("4", "proj-org", "open"),
  task("5", "proj-org", "dropped"),
  task("6", "proj-inbox", "done"), task("7", "proj-inbox", "open"),
  task("8", "proj-billing", "open"),
];

export const FIXTURE_INITIATIVES: InitiativeRow[] = [
  row({
    _id: "init-org", short_id: "in-1", title: "Agents run the company's routine work", status: "active",
    description: "Every area of the product has a lead that is an agent, and a person reads one page to know how it is going.\n\nScope: the org chart, roles, scopes and the chief of staff. Not in scope: billing for agent seats.",
    owner: { kind: "role", role_id: "fixture-role-growth" }, target_date: FIXTURE_NOW + 60 * DAY, priority: "p0",
    project_ids: ["proj-org", "proj-inbox"], health: "at_risk", health_at: FIXTURE_NOW - 2 * DAY, latest_update_id: "upd-2",
  }),
  row({
    _id: "init-org-sub", short_id: "in-2", title: "The role page is the session page", status: "active",
    owner: { kind: "role", role_id: "fixture-role-growth" }, parent_initiative_id: "init-org", project_ids: ["proj-org"],
    health: "on_track", health_at: FIXTURE_NOW - DAY,
  }),
  row({
    _id: "init-revenue", short_id: "in-3", title: "Paid teams by the end of the year", status: "planned",
    owner: { kind: "user", user_id: "fixture-user-me" }, target_date: FIXTURE_NOW + 100 * DAY,
    project_ids: ["proj-billing", "proj-inbox"],
  }),
  row({ _id: "init-orphan", short_id: "in-4", title: "Mobile parity", status: "proposed" }),
  row({ _id: "init-done", short_id: "in-5", title: "Local first everywhere", status: "completed", owner: { kind: "user", user_id: "fixture-user-me" }, health: "on_track", health_at: FIXTURE_NOW - 20 * DAY }),
];

const update = (u: Pick<InitiativeUpdateRow, "_id" | "body" | "health" | "by" | "at">): InitiativeUpdateRow => ({ initiative_id: "init-org", workspace: WS, user_id: "fixture-user-me", ...u });
export const FIXTURE_UPDATES: InitiativeUpdateRow[] = [
  update({ _id: "upd-2", body: "The scope view ships this week. The inbox project is three days past its target and has no lead, which is why this reads at risk.", health: "at_risk", by: { kind: "role", role_id: "fixture-role-growth", conversation_id: "conv-standing" }, at: FIXTURE_NOW - 2 * DAY }),
  update({ _id: "upd-1", body: "Roles can own tasks and the chart is live.", health: "on_track", by: { kind: "user", user_id: "fixture-user-me" }, at: FIXTURE_NOW - 9 * DAY }),
];
