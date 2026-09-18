// A role as a task's assignee (docs/architecture/org-roles-run-work.md R5):
// `tasks.assignee` holds a role's id beside a user's, a session that takes a
// task assigns it to the role it works for, a person handing a task to a role
// wakes it, and `--chain` reads the reporting line at query time.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { list, update, webUpdate } from "./tasks";
import { hashToken } from "./apiTokens";

// Real Convex ids are 32 lowercase characters, and resolveAssigneeStr passes
// exactly that shape through as an id, so the fixtures use it.
const id = (name: string) => name.padEnd(32, "0");
const OWNER = id("userowner");
const JASON = id("userjason");
const TEAM = id("teamunion");
const OTHER_TEAM = id("teamother");
const GROWTH = id("rolegrowth");
const ADS = id("roleads");
const PLATFORM = id("roleplatform");
const RETIRED = id("roleretired");
const FOREIGN = id("roleforeign");
const PROJECT = id("projectgrowth");
const TOKEN = "role-assignee-token";

const role = (_id: string, handle: string, extra: Record<string, any> = {}) => ({
  _id, short_id: `or-${handle}`, name: handle, handle, status: "active", scope_type: "team", team_id: TEAM,
  host_user_id: OWNER, anchor_id: `anchors_${handle}`, scope: { project_ids: [], plan_ids: [PROJECT] }, reports_to: { kind: "user", user_id: OWNER },
  ...extra,
});

const ROLES = [
  // Growth looks after one project; ads reports to growth; platform to Jason.
  role(GROWTH, "growth", { name: "Head of Growth", scope: { project_ids: [PROJECT], plan_ids: [] } }),
  role(ADS, "ads", { reports_to: { kind: "role", role_id: GROWTH } }),
  role(PLATFORM, "platform", { reports_to: { kind: "user", user_id: JASON } }),
  role(RETIRED, "old", { status: "retired" }),
  role(FOREIGN, "elsewhere", { team_id: OTHER_TEAM }),
];

const CONVERSATIONS = [
  { _id: "conversations_hand", session_id: "hand-growth", user_id: OWNER, team_id: TEAM, status: "active", org_role_id: GROWTH },
  { _id: "conversations_standing", session_id: "standing-growth", user_id: OWNER, team_id: TEAM, status: "active", standing_role_id: GROWTH },
  { _id: "conversations_hand_ads", session_id: "hand-ads", user_id: OWNER, team_id: TEAM, status: "active", org_role_id: ADS },
  { _id: "conversations_free", session_id: "free", user_id: OWNER, team_id: TEAM, status: "active" },
];

const task = (n: number, extra: Record<string, any> = {}) => ({
  _id: `tasks_${n}`, short_id: `ct-${n}`, title: `Task ${n}`, user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`,
  status: "open", source: "human", updated_at: n, created_at: n, ...extra,
});

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: OWNER, name: "Ashot", github_username: "ashot", active_team_id: TEAM, team_id: TEAM },
      { _id: JASON, name: "Jason Benn", github_username: "jbenn", active_team_id: TEAM, team_id: TEAM },
    ],
    teams: [{ _id: TEAM, name: "Union" }, { _id: OTHER_TEAM, name: "Other" }],
    team_memberships: [
      { _id: "tm_1", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "tm_2", user_id: JASON, team_id: TEAM, role: "member" },
    ],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    org_roles: ROLES.map((r) => ({ ...r })),
    tasks,
    task_history: [],
    entity_subscriptions: [],
    role_wake_outbox: [],
    conversations: CONVERSATIONS.map((c) => ({ ...c })),
  };
  const db = makeFakeDb(tables);
  const scheduled: any[] = [];
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
    scheduler: { runAfter: async (...a: any[]) => { scheduled.push(a); return null; } },
    async runMutation() { return null; },
  } as any;
  return { ctx, tables, scheduled };
}

const cliUpdate = (ctx: any, args: Record<string, any>) => (update as any)._handler(ctx, { api_token: TOKEN, ...args });
const start = (ctx: any, shortId: string, session: string) => cliUpdate(ctx, { short_id: shortId, status: "in_progress", conversation_id: session });
const ls = (ctx: any, args: Record<string, any>) => (list as any)._handler(ctx, { api_token: TOKEN, workspace: "team", team_id: TEAM, ...args });

describe("a role is an assignee", () => {
  test("@handle round trips: stored as the role's id, read back by handle, named in the list", async () => {
    const { ctx, tables } = await makeCtx([task(1), task(2, { assignee: JASON })]);
    await cliUpdate(ctx, { short_id: "ct-1", assignee: "@growth" });
    expect(tables.tasks[0].assignee).toBe(GROWTH);
    expect(tables.task_history.find((h: any) => h.field === "assignee")).toMatchObject({ old_value: "", new_value: GROWTH });

    const rows = await ls(ctx, { assignee: "@growth" });
    expect(rows.map((r: any) => r.short_id)).toEqual(["ct-1"]);
    expect(rows[0].assignee_name).toBe("@growth");
  });

  test("a teammate with the same handle wins, as in chat, and only on an exact match", async () => {
    const { ctx, tables } = await makeCtx([task(1), task(2)]);
    tables.users[1].github_username = "growth";
    await cliUpdate(ctx, { short_id: "ct-1", assignee: "@growth" });
    expect(tables.tasks[0].assignee).toBe(JASON);
    // "@ads" is inside nobody's name exactly, though "jasonads@…" would match a substring.
    tables.users[1].email = "jasonads@example.com";
    await cliUpdate(ctx, { short_id: "ct-2", assignee: "@ads" });
    expect(tables.tasks[1].assignee).toBe(ADS);
  });

  test("a handle nobody answers to is refused, never stored as a bare string", async () => {
    const { ctx, tables } = await makeCtx([task(1)]);
    await expect(cliUpdate(ctx, { short_id: "ct-1", assignee: "@nobody-here" })).rejects.toThrow(/Nobody answers to @nobody-here/);
    // A role in another workspace does not answer here either.
    await expect(cliUpdate(ctx, { short_id: "ct-1", assignee: "@elsewhere" })).rejects.toThrow(/Nobody answers to @elsewhere/);
    expect(tables.tasks[0].assignee).toBeUndefined();
  });

  test("a retired role and a role from another workspace are refused in plain words", async () => {
    const { ctx, tables } = await makeCtx([task(1)]);
    await expect(cliUpdate(ctx, { short_id: "ct-1", assignee: RETIRED })).rejects.toThrow(/@old is retired/);
    await expect(cliUpdate(ctx, { short_id: "ct-1", assignee: FOREIGN })).rejects.toThrow(/another workspace/);
    await expect((webUpdate as any)._handler(ctx, { short_id: "ct-1", assignee: FOREIGN })).rejects.toThrow(/another workspace/);
    expect(tables.tasks[0].assignee).toBeUndefined();
  });
});

describe("a session that takes a task assigns it to its role", () => {
  test("a hand's start hands the unassigned task to the role and stays bound to it", async () => {
    const { ctx, tables } = await makeCtx([task(1)]);
    const result = await start(ctx, "ct-1", "hand-growth");
    expect(tables.tasks[0]).toMatchObject({ assignee: GROWTH, status: "in_progress" });
    expect(tables.conversations[0].active_task_id).toBe("tasks_1");
    expect(result.assigned_role).toEqual({ handle: "growth", name: "Head of Growth" });
    expect(tables.task_history.some((h: any) => h.field === "assignee" && h.new_value === GROWTH)).toBe(true);
  });

  test("the role's standing session does the same", async () => {
    const { ctx, tables } = await makeCtx([task(1)]);
    await start(ctx, "ct-1", "standing-growth");
    expect(tables.tasks[0].assignee).toBe(GROWTH);
  });

  test("a person's task is not reassigned", async () => {
    const { ctx, tables } = await makeCtx([task(1, { assignee: JASON })]);
    const result = await start(ctx, "ct-1", "hand-growth");
    expect(tables.tasks[0]).toMatchObject({ assignee: JASON, status: "in_progress" });
    expect(tables.conversations[0].active_task_id).toBe("tasks_1");
    expect(result.assigned_role).toBeUndefined();
    expect(tables.task_history.some((h: any) => h.field === "assignee")).toBe(false);
  });

  test("a name nobody resolved still names a person", async () => {
    const { ctx, tables } = await makeCtx([task(1, { assignee: "Priya" })]);
    await start(ctx, "ct-1", "hand-growth");
    expect(tables.tasks[0].assignee).toBe("Priya");
  });

  test("another role's task moves to the role now doing the work", async () => {
    const { ctx, tables } = await makeCtx([task(1, { assignee: GROWTH })]);
    await start(ctx, "ct-1", "hand-ads");
    expect(tables.tasks[0].assignee).toBe(ADS);
  });

  // Taking over, not creating: a task with an assignee shows on the person's
  // default board, so a session's own bookkeeping must not gain one.
  test("takes over a task a person filed with no assignee: assigned to the role", async () => {
    const { ctx, tables } = await makeCtx([task(1, { source: "human" })]);
    await start(ctx, "ct-1", "hand-growth");
    expect(tables.tasks[0].assignee).toBe(GROWTH);
  });

  test("starts a task it filed itself: stays unassigned and internal", async () => {
    const { ctx, tables } = await makeCtx([task(1, { source: "agent", created_from_conversation: "conversations_hand" })]);
    const result = await start(ctx, "ct-1", "hand-growth");
    expect(tables.tasks[0]).toMatchObject({ status: "in_progress" });
    expect(tables.tasks[0].assignee).toBeUndefined();
    expect(result.assigned_role).toBeUndefined();
    // Another hand of the same role taking that task over does assign it.
    await start(ctx, "ct-1", "standing-growth");
    expect(tables.tasks[0].assignee).toBe(GROWTH);
  });

  test("starts a subtask: stays nested with no assignee of its own", async () => {
    const { ctx, tables } = await makeCtx([task(1), task(2, { parent_id: "tasks_1" })]);
    await start(ctx, "ct-2", "hand-growth");
    expect(tables.tasks[1]).toMatchObject({ status: "in_progress" });
    expect(tables.tasks[1].assignee).toBeUndefined();
  });

  test("the role's standing session follows the same rule", async () => {
    const { ctx, tables } = await makeCtx([task(1, { created_from_conversation: "conversations_standing" })]);
    await start(ctx, "ct-1", "standing-growth");
    expect(tables.tasks[0].assignee).toBeUndefined();
  });

  test("a session under no role leaves the assignee alone", async () => {
    const { ctx, tables } = await makeCtx([task(1)]);
    const result = await start(ctx, "ct-1", "free");
    expect(tables.tasks[0].assignee).toBeUndefined();
    expect(result.assigned_role).toBeUndefined();
  });

  test("taking a task never wakes the role that took it", async () => {
    const { ctx, tables } = await makeCtx([task(1)]);
    await start(ctx, "ct-1", "hand-growth");
    expect(tables.role_wake_outbox).toEqual([]);
  });
});

describe("a person assigning a task to a role wakes it", () => {
  test("one fold row with the task in it, for a task outside the role's scope", async () => {
    const { ctx, tables, scheduled } = await makeCtx([task(7, { title: "Fix the pricing copy" })]);
    await cliUpdate(ctx, { short_id: "ct-7", assignee: "@ads" });
    expect(tables.role_wake_outbox).toHaveLength(1);
    expect(tables.role_wake_outbox[0]).toMatchObject({
      role_id: ADS,
      kind: "fold",
      cause: 'Ashot assigned you ct-7 "Fix the pricing copy"',
      ref: { table: "tasks", id: "tasks_7", short_id: "ct-7" },
    });
    expect(scheduled).toHaveLength(1);
  });

  test("the board's assign wakes it the same way", async () => {
    const { ctx, tables } = await makeCtx([task(7)]);
    await (webUpdate as any)._handler(ctx, { short_id: "ct-7", assignee: ADS });
    expect(tables.role_wake_outbox.map((r: any) => [r.role_id, r.kind])).toEqual([[ADS, "fold"]]);
  });

  // `_handler` is the handler functions.ts wrapped, so the post write hook
  // runs here as it does in production: it sees the same task write and would
  // fold "task ct-7 is open" over the assignment if the two were separate rows.
  test("a task inside the role's scope is still ONE row, and it says assigned", async () => {
    const { ctx, tables } = await makeCtx([task(7, { project_id: PROJECT, title: "Fix the pricing copy" })]);
    await cliUpdate(ctx, { short_id: "ct-7", assignee: "@growth" });
    const rows = tables.role_wake_outbox.filter((r: any) => r.role_id === GROWTH);
    expect(rows).toHaveLength(1);
    expect(rows[0].cause).toBe('Ashot assigned you ct-7 "Fix the pricing copy"');
    expect(rows[0].count ?? 1).toBe(1);
  });

  test("assigning to a person wakes no role", async () => {
    const { ctx, tables } = await makeCtx([task(7)]);
    await cliUpdate(ctx, { short_id: "ct-7", assignee: JASON });
    expect(tables.role_wake_outbox).toEqual([]);
  });
});

describe("cast task ls --chain", () => {
  const board = () => [
    task(1, { assignee: OWNER }),
    task(2, { assignee: GROWTH }),
    task(3, { assignee: ADS }),
    task(4, { assignee: PLATFORM }),
    task(5, { assignee: JASON }),
    task(6),
  ];

  test("me: my tasks and the tasks of every role that reports up to me", async () => {
    const { ctx } = await makeCtx(board());
    const rows = await ls(ctx, { chain: "me" });
    expect(rows.map((r: any) => r.short_id).sort()).toEqual(["ct-1", "ct-2", "ct-3"]);
  });

  test("another person's chain is theirs", async () => {
    const { ctx } = await makeCtx(board());
    const rows = await ls(ctx, { chain: "jbenn" });
    expect(rows.map((r: any) => r.short_id).sort()).toEqual(["ct-4", "ct-5"]);
  });

  test("a reparent moves the role's tasks to the new chain with no write to any task", async () => {
    const { ctx, tables } = await makeCtx(board());
    tables.org_roles.find((r: any) => r._id === ADS).reports_to = { kind: "user", user_id: JASON };
    expect((await ls(ctx, { chain: "me" })).map((r: any) => r.short_id).sort()).toEqual(["ct-1", "ct-2"]);
    expect((await ls(ctx, { chain: "jbenn" })).map((r: any) => r.short_id).sort()).toEqual(["ct-3", "ct-4", "ct-5"]);
  });

  test("--chain takes a person and refuses --assignee beside it", async () => {
    const { ctx } = await makeCtx(board());
    await expect(ls(ctx, { chain: "nobody-by-this-name" })).rejects.toThrow(/--chain takes a person/);
    await expect(ls(ctx, { chain: "me", assignee: "me" })).rejects.toThrow(/not both/);
  });
});
