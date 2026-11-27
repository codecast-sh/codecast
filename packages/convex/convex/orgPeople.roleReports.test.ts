import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { REPORT_WAIT_MS, roleReportsOf } from "./orgPeople";
import { roleCardOf } from "./agentTasks";
import { roleCardLines } from "@codecast/shared/contracts";

// A role's people (org-people.md P2): who reports to it, and what of its area
// waits on each, read with the reader's grants.

const ADMIN = "u".repeat(31) + "a";
const IC = "u".repeat(31) + "i";
const OTHER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const ROLE = "org_roles_growth";
const IN_AREA = "projects_growth";
const ELSEWHERE = "projects_other";
const NOW = Date.now();
const DAY = REPORT_WAIT_MS;
const WS = `team:${TEAM}`;

function fixtures() {
  const member = (id: string, user: string, extra: Record<string, any> = {}) => ({ _id: id, user_id: user, team_id: TEAM, role: "member", joined_at: 1, visibility: "full", ...extra });
  const task = (id: string, short: string, project: string, status: string, updated: number) => ({
    _id: id, short_id: short, title: `Task ${short}`, status, priority: "medium", project_id: project, assignee: IC,
    user_id: ADMIN, team_id: TEAM, workspace: WS, updated_at: updated, _creationTime: updated, source: "human",
  });
  const conv = (id: string, taskId: string) => ({ _id: id, user_id: IC, team_id: TEAM, team_visibility: "full", is_private: false, active_task_id: taskId, title: "s" });
  const decision = (id: string, short: string, convId: string, created: number) => ({ _id: id, short_id: short, conversation_id: convId, user_id: IC, question: `Pick ${short}?`, status: "pending", created_at: created, options: [] });
  return makeFakeDb({
    users: [
      { _id: ADMIN, name: "Admin", email: "a@x.ai" },
      { _id: IC, name: "Ic", email: "i@x.ai", github_username: "ic" },
      { _id: OTHER, name: "Other", email: "o@x.ai" },
    ],
    team_memberships: [
      member("m1", ADMIN, { role: "admin" }),
      member("m2", IC, { managers: [{ kind: "role", role_id: ROLE }], title: "Designer", focus: "onboarding" }),
      member("m3", OTHER),
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    org_roles: [{ _id: ROLE, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ADMIN, name: "Growth lead", handle: "growth", status: "active", scope: { project_ids: [IN_AREA], plan_ids: [] }, reports_to: { kind: "user", user_id: ADMIN } }],
    projects: [
      { _id: IN_AREA, title: "Growth", user_id: ADMIN, team_id: TEAM, workspace: WS },
      { _id: ELSEWHERE, title: "Other", user_id: ADMIN, team_id: TEAM, workspace: WS },
    ],
    tasks: [
      task("tasks_review", "ct-1", IN_AREA, "in_review", NOW - 2 * DAY),
      task("tasks_open", "ct-2", IN_AREA, "open", NOW - 3600_000),
      task("tasks_away", "ct-3", ELSEWHERE, "in_review", NOW - 5 * DAY),
    ],
    conversations: [conv("conversations_in", "tasks_open"), conv("conversations_out", "tasks_away")],
    session_decisions: [
      decision("sd_old", "sd-1", "conversations_in", NOW - 2 * DAY),
      decision("sd_new", "sd-2", "conversations_in", NOW - 3600_000),
      decision("sd_away", "sd-3", "conversations_out", NOW - 3 * DAY),
    ],
    decision_inbox: ["sd_old", "sd_new", "sd_away"].map((d, i) => ({ _id: `di${i}`, decision_id: d, user_id: IC, status: "pending", created_at: 1 })),
    counters: [], session_owners: [], managed_sessions: [], messages: [], anchors: [], docs: [], initiatives: [], plans: [],
  });
}
const ctxOf = (db: any) => ({ db }) as any;

describe("roleReportsOf", () => {
  test("lists each person reporting to the role with what of its area waits on them", async () => {
    const [p, ...rest] = await roleReportsOf(ctxOf(fixtures()), { _id: ROLE, team_id: TEAM, status: "active", scope: { project_ids: [IN_AREA], plan_ids: [] } }, ADMIN as any, NOW);
    expect(rest).toEqual([]);
    expect(p.name).toBe("Ic");
    expect(p.line).toBe("Ic @ic · Designer · onboarding");
    // The day-old decision in the area counts; the new one and the one elsewhere do not.
    expect(p.decisions.map((d) => d.short_id)).toEqual(["sd-1"]);
    // Both open tasks in the area, the review one stuck past a day; the task elsewhere is not the role's.
    expect(p.tasks.map((t) => t.short_id)).toEqual(["ct-1", "ct-2"]);
    expect(p.waits).toEqual({ decisions_over_day: 1, open_tasks: 2, review_over_day: 1 });
  });

  test("a person's priority card is theirs alone: it reaches neither the role's report nor its card", async () => {
    const db = fixtures();
    await db.patch("sd_old", { priority_card: { v: 1, changes: [] } });
    const [p] = await roleReportsOf(ctxOf(db), { _id: ROLE, team_id: TEAM, status: "active", scope: { project_ids: [IN_AREA], plan_ids: [] } }, ADMIN as any, NOW);
    expect(p.decisions).toEqual([]);
    expect(p.waits.decisions_over_day).toBe(0);
    expect((await roleCardOf(ctxOf(db), ROLE as any))?.people[0].waits).not.toContain("1 decision waiting over a day");
  });

  test("a role nobody reports to reads nobody, and a retired one nothing", async () => {
    const db = fixtures();
    expect(await roleReportsOf(ctxOf(db), { _id: "org_roles_none", team_id: TEAM, status: "active", scope: { project_ids: [], plan_ids: [] } }, ADMIN as any, NOW)).toEqual([]);
    expect(await roleReportsOf(ctxOf(db), { _id: ROLE, team_id: TEAM, status: "retired" }, ADMIN as any, NOW)).toEqual([]);
  });

  test("the role's card carries each person's line and waits, in words", async () => {
    const card = await roleCardOf(ctxOf(fixtures()), ROLE as any);
    expect(card?.people).toEqual([{ line: "Ic @ic · Designer · onboarding", waits: ["1 decision waiting over a day", "1 task in review over a day", "2 open tasks"] }]);
    expect(roleCardLines(card!)).toContain("Reports to it: Ic @ic · Designer · onboarding · waits on them: 1 decision waiting over a day, 1 task in review over a day, 2 open tasks");
  });
});
