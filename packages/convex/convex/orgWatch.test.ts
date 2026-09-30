import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { AREA_WATCH_PASSES, performApplyAreaWatch, planAreaWatch, type WatchInput, type WatchPlan } from "./orgWatch";
import { parseScheduledTask } from "@codecast/shared/contracts";
import { ORG_AREA_CHANGE_EVENT } from "@codecast/shared/contracts";
import { CHIEF_AREA_CHANGE_TITLE } from "./lib/orgRoutine";

// The area watch (docs/architecture/org-staffing.md S29): a pressing status
// that holds across two passes reaches the Chief of Staff once per episode;
// a project with work and no owner once until it gains one; nothing a person
// must act on is routed to the chief; and what fires is the chief's own
// event trigger with the change in its frame.

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const role = (over: Partial<WatchInput["roles"][number]> = {}): WatchInput["roles"][number] => ({
  role_id: "org_roles_growth", handle: "growth", name: "Growth lead", status: "stuck", status_line: "Stuck: 1 session under it waiting unanswered.", area_watch: null, ...over,
});
const input = (roles: WatchInput["roles"], over: Partial<WatchInput> = {}): WatchInput => ({ now: NOW, roles, chief: { role_id: "org_roles_chief", unowned_told: [] }, unowned: [], ...over });
const next = (plan: WatchPlan, id = "org_roles_growth") => plan.role_writes.find((w) => w.role_id === id)!.area_watch;

describe("planAreaWatch", () => {
  test("a pressing status reaches the chief at the second pass in a row, once, and again only in a new episode", () => {
    expect(AREA_WATCH_PASSES).toBe(2);
    // Pass 1: remembered, not told.
    const p1 = planAreaWatch(input([role()]));
    expect(p1.changes).toEqual([]);
    expect(next(p1)).toEqual({ status: "stuck", since: NOW, passes: 1 });
    // Pass 2: the same status, told once, with what it changed from.
    const p2 = planAreaWatch(input([role({ area_watch: next(p1) })], { now: NOW + 6 * H }));
    expect(p2.changes).toHaveLength(1);
    expect(p2.changes[0].change).toEqual({ kind: "status", role_handle: "growth", role_name: "Growth lead", from: null, to: "stuck", since: NOW, line: "Stuck: 1 session under it waiting unanswered." });
    expect(p2.changes[0].client_id).toBe(`area-change:org_roles_growth:stuck:${NOW}`);
    expect(next(p2)).toEqual({ status: "stuck", since: NOW, passes: 2, told: "stuck", told_at: NOW + 6 * H });
    // Pass 3: still stuck, nothing new to say.
    const p3 = planAreaWatch(input([role({ area_watch: next(p2) })], { now: NOW + 12 * H }));
    expect(p3.changes).toEqual([]);
    expect(next(p3).passes).toBe(3);
    // It recovers: a new episode, from stuck, and the told mark is forgotten.
    const p4 = planAreaWatch(input([role({ status: "on_track", status_line: "On track.", area_watch: next(p3) })], { now: NOW + 18 * H }));
    expect(p4.changes).toEqual([]);
    expect(next(p4)).toEqual({ status: "on_track", since: NOW + 18 * H, passes: 1, from: "stuck" });
    // Stuck again for two passes: told again, naming what it came from.
    const p5 = planAreaWatch(input([role({ area_watch: next(p4) })], { now: NOW + 24 * H }));
    const p6 = planAreaWatch(input([role({ area_watch: next(p5) })], { now: NOW + 30 * H }));
    expect(p5.changes).toEqual([]);
    expect(p6.changes.map((c) => c.change)).toEqual([expect.objectContaining({ kind: "status", from: "on_track", to: "stuck", since: NOW + 24 * H })]);
  });

  test("overloaded is the other status that reaches the chief; waiting on you, quiet, on track and paused never do", () => {
    const held = (status: WatchInput["roles"][number]["status"]) => planAreaWatch(input([role({ status, status_line: status, area_watch: { status, since: NOW - 6 * H, passes: 1 } })])).changes.length;
    expect(held("overloaded")).toBe(1);
    expect(held("stuck")).toBe(1);
    expect(held("waiting_on_you")).toBe(0);
    expect(held("quiet")).toBe(0);
    expect(held("on_track")).toBe(0);
    expect(held("paused")).toBe(0);
    expect(held("not_started")).toBe(0);
  });

  test("a row is written only when something moved; a steady told episode writes its pass count", () => {
    const steady = { status: "on_track", since: NOW - 6 * H, passes: 4 };
    const p = planAreaWatch(input([role({ status: "on_track", status_line: "On track.", area_watch: steady })]));
    expect(p.role_writes).toEqual([{ role_id: "org_roles_growth", area_watch: { ...steady, passes: 5 } }]);
    expect(p.chief_write).toBeNull();
  });

  test("a project with work and no owner is told once, pruned when it gains an owner, and told again if it loses one", () => {
    const p1 = planAreaWatch(input([], { unowned: [{ id: "projects_platform", title: "Platform" }] }));
    expect(p1.changes.map((c) => c.change)).toEqual([{ kind: "unowned_project", project_id: "projects_platform", project_title: "Platform", since: NOW, line: "No role's area includes it." }]);
    expect(p1.chief_write).toEqual({ role_id: "org_roles_chief", unowned_told: [{ id: "projects_platform", since: NOW }] });
    const told = p1.chief_write!.unowned_told;
    // Still unowned next pass: nothing said, nothing written.
    const p2 = planAreaWatch(input([], { now: NOW + 6 * H, unowned: [{ id: "projects_platform", title: "Platform" }], chief: { role_id: "org_roles_chief", unowned_told: told } }));
    expect(p2.changes).toEqual([]);
    expect(p2.chief_write).toBeNull();
    // Owned now: the mark is dropped.
    const p3 = planAreaWatch(input([], { now: NOW + 12 * H, unowned: [], chief: { role_id: "org_roles_chief", unowned_told: told } }));
    expect(p3.chief_write).toEqual({ role_id: "org_roles_chief", unowned_told: [] });
    // Unowned again later: told again.
    const p4 = planAreaWatch(input([], { now: NOW + 18 * H, unowned: [{ id: "projects_platform", title: "Platform" }], chief: { role_id: "org_roles_chief", unowned_told: [] } }));
    expect(p4.changes).toHaveLength(1);
  });
});

describe("performApplyAreaWatch", () => {
  const ME = "u".repeat(31) + "m";
  const TEAM = "teams_acme" as any;
  const CHIEF = "org_roles_chief";
  const STANDING = "conversations_standing_chief";
  const world = () => makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    org_roles: [
      { _id: CHIEF, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Chief of Staff", handle: "chief-of-staff", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_chief", created_by: ME, created_at: 1, updated_at: 1 },
      { _id: "org_roles_growth", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
    ],
    anchors: [{ _id: "anchors_chief", name: "Chief of Staff", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: ME, org_role_id: CHIEF, conversation_id: STANDING, status: "active" }],
    conversations: [{ _id: STANDING, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Chief of Staff", short_id: "jx7chief", session_id: "sess_chief", project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 4, standing_role_id: CHIEF, anchor_id: "anchors_chief", persistent: true }],
    agent_tasks: [], pending_messages: [], counters: [], docs: [],
  });
  const plan = (changes: WatchPlan["changes"]): WatchPlan => ({
    role_writes: [{ role_id: "org_roles_growth", area_watch: { status: "stuck", since: NOW, passes: 2, told: "stuck", told_at: NOW } }],
    chief_write: { role_id: CHIEF, unowned_told: [{ id: "projects_platform", since: NOW }] },
    changes,
  });

  test("writes the watch state and fires the chief's own trigger once per change, the change in the frame", async () => {
    const db = world();
    const ctx = { db } as any;
    const changes: WatchPlan["changes"] = [
      { change: { kind: "status", role_handle: "growth", role_name: "Growth lead", from: null, to: "stuck", since: NOW, line: "Stuck: 1 session under it waiting unanswered." }, client_id: `area-change:org_roles_growth:stuck:${NOW}` },
      { change: { kind: "unowned_project", project_id: "projects_platform", project_title: "Platform", since: NOW, line: "No role's area includes it." }, client_id: `area-change:project:projects_platform:${NOW}` },
    ];
    expect(await performApplyAreaWatch(ctx, CHIEF as any, plan(changes))).toBe(2);
    expect((await db.get("org_roles_growth" as any)).area_watch).toEqual({ status: "stuck", since: NOW, passes: 2, told: "stuck", told_at: NOW });
    expect((await db.get(CHIEF as any)).unowned_told).toEqual([{ id: "projects_platform", since: NOW }]);
    // One trigger, armed on first use on the chief's standing session, run twice.
    const triggers = db._tables.agent_tasks;
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ title: CHIEF_AREA_CHANGE_TITLE, schedule_type: "event", event_filter: { event_type: ORG_AREA_CHANGE_EVENT }, role_id: CHIEF, originating_conversation_id: STANDING, status: "scheduled", run_count: 2 });
    const frames = db._tables.pending_messages.map((m: any) => parseScheduledTask(m.content)!);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ title: CHIEF_AREA_CHANGE_TITLE, event: ORG_AREA_CHANGE_EVENT, role: expect.objectContaining({ handle: "chief-of-staff" }) });
    expect(frames[0].change).toEqual({ kind: "status", role_handle: "growth", role_name: "Growth lead", from: null, to: "stuck", since: NOW, line: "Growth lead (@growth) has read stuck at two checks in a row. Stuck: 1 session under it waiting unanswered." });
    expect(frames[1].change).toEqual({ kind: "unowned_project", project_id: "projects_platform", project_title: "Platform", since: NOW, line: 'The project "Platform" has work and no role looking after it.' });
    expect(frames[0].waiting).toBeNull();
    expect(db._tables.pending_messages.every((m: any) => m.origin === "scheduler")).toBe(true);
  });

  test("a paused trigger, or a chief the org cannot reach, is not told; the episode still counts as told so it never fires twice", async () => {
    const db = world();
    const ctx = { db } as any;
    const changes: WatchPlan["changes"] = [{ change: { kind: "status", role_handle: "growth", role_name: "Growth lead", from: null, to: "stuck", since: NOW, line: "Stuck." }, client_id: "area-change:x" }];
    // Arm it by firing once, then pause it: the person's control.
    expect(await performApplyAreaWatch(ctx, CHIEF as any, plan(changes))).toBe(1);
    await db.patch(db._tables.agent_tasks[0]._id, { status: "paused" });
    expect(await performApplyAreaWatch(ctx, CHIEF as any, plan([{ ...changes[0], client_id: "area-change:y" }]))).toBe(0);
    expect(db._tables.pending_messages).toHaveLength(1);
    // The org feature off: nothing reaches the chief.
    await db.patch(TEAM, { features: { org: false } });
    await db.patch(db._tables.agent_tasks[0]._id, { status: "scheduled" });
    expect(await performApplyAreaWatch(ctx, CHIEF as any, plan([{ ...changes[0], client_id: "area-change:z" }]))).toBe(0);
  });
});
