import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performSetReports } from "./orgRoles";
import { computeReportingPeople, goalKey, noticeGoalStalls, stampGoalsSeen } from "./orgGoals";

// A person who reports to a role (docs/architecture/org-roles-run-work.md R6):
// who may report, the goals read against the live rows, what counts as a
// stall, and the one notice a day.

const ME = "u".repeat(31) + "m"; // team admin
const MATE = "u".repeat(31) + "t"; // plain member
const OUTSIDER = "u".repeat(31) + "o"; // not in the team
const TEAM = "teams_acme" as any;
const NOW = Date.parse("2026-09-19T15:00:00Z");
const H = 3_600_000;
const D = 24 * H;

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me Admin", email: "me@x.ai" },
      { _id: MATE, name: "Mate Member", email: "mate@x.ai" },
      { _id: OUTSIDER, name: "Out Sider", email: "out@y.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [], org_roles: [], org_role_history: [], org_role_events: [], conversations: [], session_owners: [], managed_sessions: [],
    messages: [], user_presence: [], pending_messages: [], devices: [], anchors: [],
    tasks: [], plans: [], docs: [],
    ...extra,
  });
}
const ctxOf = (db: any) => ({ db }) as any;

describe("who reports to a role", () => {
  test("a member adds and removes themself; only an admin names someone else", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Chief", handle: "chief", team_id: TEAM });
    const joined = await performSetReports(ctx, MATE as any, { role_id: role.short_id, add: [MATE as any] });
    expect(joined.reports_user_ids).toEqual([MATE]);
    await expect(performSetReports(ctx, MATE as any, { role_id: role.short_id, add: [ME as any] })).rejects.toThrow(/admin/);
    const both = await performSetReports(ctx, ME as any, { role_id: role.short_id, add: [ME as any] });
    expect(both.reports_user_ids.sort()).toEqual([ME, MATE].sort());
    await expect(performSetReports(ctx, ME as any, { role_id: role.short_id, add: [OUTSIDER as any] })).rejects.toThrow(/not in this workspace/);
    const left = await performSetReports(ctx, MATE as any, { role_id: role.short_id, remove: [MATE as any] });
    expect(left.reports_user_ids).toEqual([ME]);
  });

  test("the whole list from a surface becomes the difference against the stored row", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Chief", handle: "chief", team_id: TEAM });
    await performSetReports(ctx, ME as any, { role_id: role.short_id, add: [ME as any, MATE as any] });
    const after = await performSetReports(ctx, ME as any, { role_id: role.short_id, set: [MATE as any] });
    expect(after.reports_user_ids).toEqual([MATE]);
    // A member holding a stale list may still only change their own row.
    await expect(performSetReports(ctx, MATE as any, { role_id: role.short_id, set: [MATE as any, ME as any] })).rejects.toThrow(/admin/);
    expect((await performSetReports(ctx, MATE as any, { role_id: role.short_id, set: [] })).reports_user_ids).toEqual([]);
  });
});

const BRIEF = [
  "Chief: steady",
  "",
  "## Goals: Mate",
  "1. Ship org roles (high) — ct-7, jx7priv",
  "2. Close the round (high)",
  "3. Reliable OTA — ct-8",
].join("\n");

function goalFixtures() {
  return fixtures({
    tasks: [
      { _id: "t7", short_id: "ct-7", title: "R6", status: "in_progress", user_id: MATE, team_id: TEAM, workspace: `team:${TEAM}`, updated_at: NOW - 2 * H },
      { _id: "t8", short_id: "ct-8", title: "OTA rollback", status: "done", user_id: MATE, team_id: TEAM, workspace: `team:${TEAM}`, updated_at: NOW - 5 * D },
    ],
    conversations: [
      // Mate's private session: the role's host cannot open it.
      { _id: "c1", short_id: "jx7priv", title: "Private", user_id: MATE, is_private: true, status: "active", updated_at: NOW - H },
    ],
  });
}

describe("goals read against the live rows", () => {
  test("what moved, what stalled, and a session the viewer cannot open is never matched", async () => {
    const db = goalFixtures();
    const role = { _id: "r1", reports_user_ids: [MATE], goal_first_seen: { [goalKey(MATE, "Close the round")]: NOW - 4 * D } };
    const [mate] = await computeReportingPeople(ctxOf(db), ME as any, role, { content: BRIEF }, null, NOW - 8 * H, NOW);
    expect(mate).toMatchObject({ name: "Mate Member", has_section: true, stalled_high: 1 });
    expect(mate.goals[0]).toMatchObject({ text: "Ship org roles", priority: "high", stalled: false, unresolved: ["jx7priv"] });
    expect(mate.goals[0].refs.map((r) => r.short_id)).toEqual(["ct-7"]);
    // Nothing matched: its age is since the sweep first saw it, never the brief's.
    expect(mate.goals[1]).toMatchObject({ text: "Close the round", moved_at: null, stalled: true, unmatched: false });
    expect(mate.goals[2]).toMatchObject({ text: "Reliable OTA", priority: null, stalled: true });
  });

  test("a goal nobody has stamped yet is new, and a week unmatched is a finding", async () => {
    const db = goalFixtures();
    const fresh = await computeReportingPeople(ctxOf(db), ME as any, { _id: "r1", reports_user_ids: [MATE] }, { content: BRIEF }, null, NOW, NOW);
    expect(fresh[0].goals[1]).toMatchObject({ stalled: false, unmatched: false });
    const old = await computeReportingPeople(ctxOf(db), ME as any, { _id: "r1", reports_user_ids: [MATE], goal_first_seen: { [goalKey(MATE, "Close the round")]: NOW - 8 * D } }, { content: BRIEF }, null, NOW, NOW);
    expect(old[0].goals[1]).toMatchObject({ stalled: true, unmatched: true });
  });

  test("the sweep stamps a goal once, keeps the stamp across brief rewrites, and forgets a goal that left", async () => {
    const db = fixtures({ org_roles: [{ _id: "r1", reports_user_ids: [MATE], status: "active" }] });
    const ctx = ctxOf(db);
    const first = await stampGoalsSeen(ctx, await db.get("r1"), BRIEF, NOW - 2 * D);
    expect(Object.keys(first.goal_first_seen)).toHaveLength(3);
    const again = await stampGoalsSeen(ctx, await db.get("r1"), BRIEF.replace("Chief: steady", "Chief: busy"), NOW);
    expect(again.goal_first_seen[goalKey(MATE, "Close the round")]).toBe(NOW - 2 * D);
    const dropped = await stampGoalsSeen(ctx, await db.get("r1"), BRIEF.replace("2. Close the round (high)\n", ""), NOW);
    expect(Object.keys(dropped.goal_first_seen)).toHaveLength(2);
  });
});

describe("the stall notice", () => {
  test("one notice per person per UTC day, only for a stalled high goal", async () => {
    const db = fixtures({ org_roles: [{ _id: "r1", short_id: "or-1", name: "Chief", handle: "chief", reports_user_ids: [MATE], status: "active" }] });
    const sent: any[] = [];
    const ctx = { db, runMutation: async (_fn: any, args: any) => { sent.push(args); return { notified: 1 }; } } as any;
    const goal = (over: Record<string, any>) => ({ text: "Close the round", priority: "high", raw: "", refs: [], unresolved: [], moved_at: null, stalled: true, unmatched: false, ...over });
    const person = (goals: any[]) => [{ user_id: MATE, name: "Mate", has_section: true, goals, sessions_changed: [], sessions_total: 0, stalled_high: 1 }];
    expect(await noticeGoalStalls(ctx, await db.get("r1"), null, person([goal({})]), NOW)).toBe(1);
    expect(sent[0]).toMatchObject({ event_type: "goal_stall", entity_type: "org_role", entity_id: "or-1", direct_recipient_id: MATE });
    expect(sent[0].message).toContain("Close the round");
    expect(await noticeGoalStalls(ctx, await db.get("r1"), null, person([goal({})]), NOW + H)).toBe(0);
    expect(await noticeGoalStalls(ctx, await db.get("r1"), null, person([goal({})]), NOW + D)).toBe(1);
    // A stalled goal that is not high priority is the role's to name, not a notice.
    expect(await noticeGoalStalls(ctx, await db.get("r1"), null, person([goal({ priority: null })]), NOW + 3 * D)).toBe(0);
    expect(sent).toHaveLength(2);
  });
});

