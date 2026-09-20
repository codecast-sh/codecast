// REVIEW (W7, CLI and task assignment half). Each test states the behaviour the
// contract asks for (docs/architecture/org-roles-run-work.md R5) and fails on
// the code as it stands. Fixtures mirror tasks.roleAssignee.test.ts.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { list, update, batchAssign } from "./tasks";
import { hashToken } from "./apiTokens";

const id = (name: string) => name.padEnd(32, "0");
const OWNER = id("userowner");
const JASON = id("userjason");
const BOT = id("userbotgrowth");
const TEAM = id("teamunion");
const GROWTH = id("rolegrowth");
const RETIRED = id("roleretired");
const TOKEN = "review-role-assignee-token";

const role = (_id: string, handle: string, extra: Record<string, any> = {}) => ({
  _id, short_id: `or-${handle}`, name: handle, handle, status: "active", scope_type: "team", team_id: TEAM,
  host_user_id: OWNER, anchor_id: `anchors_${handle}`, scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: OWNER },
  ...extra,
});

const task = (n: number, extra: Record<string, any> = {}) => ({
  _id: `tasks_${n}`, short_id: `ct-${n}`, title: `Task ${n}`, user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`,
  status: "open", source: "human", updated_at: n, created_at: n, ...extra,
});

async function makeCtx(tasks: any[], opts: { withBot?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: OWNER, name: "Ashot", github_username: "ashot", active_team_id: TEAM, team_id: TEAM },
      { _id: JASON, name: "Jason Benn", github_username: "jbenn", active_team_id: TEAM, team_id: TEAM },
      // What anchors.provisionStandingAgent mints for a role named "Growth":
      // a bot user carrying the role's NAME, enrolled in team_memberships.
      ...(opts.withBot ? [{ _id: BOT, name: "Growth", is_bot: true, bot_kind: "role", team_id: TEAM, active_team_id: TEAM }] : []),
    ],
    teams: [{ _id: TEAM, name: "Union" }],
    team_memberships: [
      { _id: "tm_1", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "tm_2", user_id: JASON, team_id: TEAM, role: "member" },
      ...(opts.withBot ? [{ _id: "tm_3", user_id: BOT, team_id: TEAM, role: "member" }] : []),
    ],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    org_roles: [role(GROWTH, "growth", { name: "Growth" }), role(RETIRED, "old", { status: "retired" })],
    tasks,
    task_history: [],
    entity_subscriptions: [],
    role_wake_outbox: [],
    conversations: [{ _id: "conversations_hand", session_id: "hand-growth", user_id: OWNER, team_id: TEAM, status: "active", org_role_id: GROWTH }],
  };
  const db = makeFakeDb(tables);
  const emitted: any[] = [];
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
    scheduler: { runAfter: async () => null },
    async runMutation(_fn: any, args: any) { emitted.push(args); return null; },
  } as any;
  return { ctx, tables, emitted };
}

const cliUpdate = (ctx: any, args: Record<string, any>) => (update as any)._handler(ctx, { api_token: TOKEN, ...args });
const ls = (ctx: any, args: Record<string, any>) => (list as any)._handler(ctx, { api_token: TOKEN, workspace: "team", team_id: TEAM, ...args });

describe("review: the role's bot user wins the handle over the role", () => {
  // findTeamMemberId matches `u.name` exactly and never skips is_bot rows.
  // A role named with one word ("Growth", handle "growth") has a bot user on
  // the roster whose name lowercases to the handle, so "@growth" stores the
  // BOT USER id: the task sits under a fake person and the role is never woken.
  // lib/mentionResolve.ts states the opposite rule for chat ("A role outranks a
  // BOT whose name slugs to the same handle").
  test("@growth stores the role, not the bot user named after it", async () => {
    const { ctx, tables } = await makeCtx([task(1)], { withBot: true });
    await cliUpdate(ctx, { short_id: "ct-1", assignee: "@growth" });
    expect(tables.tasks[0].assignee).toBe(GROWTH);
    expect(tables.role_wake_outbox).toHaveLength(1);
  });

  test("the bare name resolves to no bot user either", async () => {
    const { ctx, tables } = await makeCtx([task(1)], { withBot: true });
    await cliUpdate(ctx, { short_id: "ct-1", assignee: "growth" });
    expect(tables.tasks[0].assignee).not.toBe(BOT);
  });
});

describe("review: the assignee filter decides access from team_id", () => {
  // tasks.list filters the global by_assignee index with
  // `t.team_id && memberTeamIds.has(t.team_id)`. team_id is routing. A task
  // routed to the team and readable only by its owner (workspace user:<owner>)
  // that a role holds is listed to every teammate who asks for the role's tasks.
  const privateTask = task(9, { user_id: JASON, workspace: `user:${JASON}`, title: "Jason's private task", assignee: GROWTH });

  test("--assignee @growth does not list a teammate's private task", async () => {
    const { ctx } = await makeCtx([task(1, { assignee: GROWTH }), privateTask]);
    const rows = await ls(ctx, { assignee: "@growth" });
    expect(rows.map((r: any) => r.short_id)).toEqual(["ct-1"]);
  });

  test("--chain me does not list it either", async () => {
    const { ctx } = await makeCtx([task(1, { assignee: GROWTH }), privateTask]);
    const rows = await ls(ctx, { chain: "me" });
    expect(rows.map((r: any) => r.short_id)).toEqual(["ct-1"]);
  });
});

describe("review: a read goes through the write resolver", () => {
  // `list` resolves its filter with resolveAssigneeStr, the WRITE resolver, so
  // asking what a retired role still holds is refused with "cannot take tasks".
  // Nothing reassigns a role's tasks at retire, and rolesInChainOf drops retired
  // roles, so those tasks also leave `--chain me`: no CLI read can find them.
  test("the tasks a retired role still holds can be listed", async () => {
    const { ctx } = await makeCtx([task(1, { assignee: RETIRED })]);
    const rows = await ls(ctx, { assignee: RETIRED }).catch((e: any) => e);
    expect(rows instanceof Error ? rows.message : rows.map((r: any) => r.short_id)).toEqual(["ct-1"]);
  });

  test("a retired role's tasks stay in the chain of the person it reported to", async () => {
    const { ctx } = await makeCtx([task(1, { assignee: RETIRED })]);
    const rows = await ls(ctx, { chain: "me" });
    expect(rows.map((r: any) => r.short_id)).toEqual(["ct-1"]);
  });
});

describe("review: batch assign reads the roster once per task", () => {
  // resolveAssigneeStr runs inside the loop: one memberships collect plus one
  // users get per member, per task. 200 tasks in a 25 person team is over 5,000
  // reads, past the 4,096 limit, before any wake row is written.
  test("the roster is read once for the batch", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(i + 1));
    const { ctx } = await makeCtx(tasks);
    let rosterReads = 0;
    const query = ctx.db.query.bind(ctx.db);
    ctx.db.query = (table: string) => { if (table === "team_memberships") rosterReads++; return query(table); };
    await (batchAssign as any)._handler(ctx, { api_token: TOKEN, short_ids: tasks.map((t) => t.short_id), assignee: "@growth" });
    expect(rosterReads).toBeLessThanOrEqual(2);
  });
});

describe("review: a hand's second task is not handed to its role", () => {
  // The role assignment sits inside the binding branch, which needs
  // `!conv.active_task_id || conv.active_task_id === task._id`. A handoff moves
  // the first task to in_review and leaves active_task_id set (only done and
  // dropped clear it), so the next `cast task start` prints "Started", binds
  // nothing and assigns nothing.
  test("start, hand off, start the next: the next task goes to the role too", async () => {
    const { ctx, tables } = await makeCtx([task(1), task(2)]);
    await cliUpdate(ctx, { short_id: "ct-1", status: "in_progress", conversation_id: "hand-growth" });
    await cliUpdate(ctx, { short_id: "ct-1", status: "in_review", execution_status: "done", verification_evidence: "ran it", conversation_id: "hand-growth" });
    const second = await cliUpdate(ctx, { short_id: "ct-2", status: "in_progress", conversation_id: "hand-growth" });
    expect(tables.tasks[1].assignee).toBe(GROWTH);
    expect(second.assigned_role).toEqual({ handle: "growth", name: "Growth" });
  });
});
