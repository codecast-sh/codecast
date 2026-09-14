// Independent review (docs/architecture/the-line.md L3): a session filed under
// an org role cannot move a task to done without an approve verdict from
// outside that role. tasks.update is the one status mutation the CLI uses
// (cast task done / handoff / verdict), so the rule lives there.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { update, webUpdate } from "./tasks";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "independent-review-token";
const ROLE_R = "org_roles_r";
const ROLE_S = "org_roles_s";

// Sessions: two hands of R, R's standing session, a hand of S, and a session
// filed under no role. All owned by OWNER so every ref resolves.
const CONVERSATIONS = [
  { _id: "conversations_hand_r1", session_id: "hand-r1", user_id: OWNER, status: "active", org_role_id: ROLE_R },
  { _id: "conversations_hand_r2", session_id: "hand-r2", user_id: OWNER, status: "active", org_role_id: ROLE_R },
  { _id: "conversations_standing_r", session_id: "standing-r", user_id: OWNER, status: "active", standing_role_id: ROLE_R },
  { _id: "conversations_hand_s", session_id: "hand-s", user_id: OWNER, status: "active", org_role_id: ROLE_S },
  { _id: "conversations_free", session_id: "free", user_id: OWNER, status: "active" },
  // The line's review station: stamped by the spawn route, filed under no role.
  { _id: "conversations_reviewer", session_id: "reviewer", user_id: OWNER, status: "active", review_of_task_id: "tasks_1" },
];

async function makeCtx(task: any) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner", github_username: "owner" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks: [task],
    task_history: [],
    entity_subscriptions: [],
    conversations: CONVERSATIONS.map((c) => ({ ...c })),
  };
  const db = makeFakeDb(tables);
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
    scheduler: { runAfter: async () => null },
    async runMutation() { return null; },
  } as any;
  return { ctx, tables };
}

const task = (extra: Record<string, any> = {}) => ({
  _id: "tasks_1", short_id: "ct-1", title: "ct-1", user_id: OWNER, status: "in_review", source: "agent", ...extra,
});
const approveBy = (id: string) => ({ verdict: "approve", by_conversation_id: id, at: 1 });

const done = (ctx: any, session: string | undefined, extra: Record<string, any> = {}) =>
  (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "done", ...(session ? { conversation_id: session } : {}), ...extra });

describe("tasks.update independent review (the-line.md L3)", () => {
  test("a hand of R cannot close without a verdict", async () => {
    const { ctx, tables } = await makeCtx(task());
    await expect(done(ctx, "hand-r1")).rejects.toThrow(/Independent review required/);
    expect(tables.tasks[0].status).toBe("in_review");
  });

  test("a hand of R cannot close on a verdict from another hand of R", async () => {
    const { ctx } = await makeCtx(task({ review_verdict: approveBy("conversations_hand_r2") }));
    await expect(done(ctx, "hand-r1")).rejects.toThrow(/same role/);
  });

  test("a hand of R cannot close on a verdict from R's standing session", async () => {
    const { ctx } = await makeCtx(task({ review_verdict: approveBy("conversations_standing_r") }));
    await expect(done(ctx, "hand-r1")).rejects.toThrow(/same role/);
  });

  test("R's standing session is held to the rule too", async () => {
    const { ctx } = await makeCtx(task({ review_verdict: approveBy("conversations_hand_r1") }));
    await expect(done(ctx, "standing-r")).rejects.toThrow(/same role/);
  });

  test("a hand cannot close its own bound work on its own approve, even written in the same call", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await expect(done(ctx, "hand-r1", { review_verdict: "approve" })).rejects.toThrow(/session doing the work/);
  });

  test("a changes verdict is not an approve", async () => {
    const { ctx } = await makeCtx(task({ review_verdict: { verdict: "changes", by_conversation_id: "conversations_free", at: 1 } }));
    await expect(done(ctx, "hand-r1")).rejects.toThrow(/without an approve verdict/);
  });

  test("a verdict from a hand of a different role lets it through", async () => {
    const { ctx, tables } = await makeCtx(task({ review_verdict: approveBy("conversations_hand_s") }));
    await done(ctx, "hand-r1");
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a session outside every role approves and closes in one call; the verdict is recorded", async () => {
    const { ctx, tables } = await makeCtx(task());
    await done(ctx, "free", { review_verdict: "approve", review_note: "criteria met" });
    const row = tables.tasks[0];
    expect(row.status).toBe("done");
    expect(row.review_verdict).toMatchObject({ verdict: "approve", by_conversation_id: "conversations_free", note: "criteria met" });
    expect(typeof row.review_verdict.at).toBe("number");
    expect(tables.task_history.some((h: any) => h.field === "review_verdict" && h.new_value === "approve")).toBe(true);
  });

  test("a hand of R closes after an outside approve was stored", async () => {
    const { ctx, tables } = await makeCtx(task({ review_verdict: approveBy("conversations_free") }));
    await done(ctx, "hand-r1");
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a person's verdict (no session) counts as outside every role", async () => {
    const { ctx, tables } = await makeCtx(task({ review_verdict: { verdict: "approve", at: 1 } }));
    await done(ctx, "hand-r1");
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a person closing from a shell is unaffected", async () => {
    const { ctx, tables } = await makeCtx(task());
    await done(ctx, undefined);
    expect(tables.tasks[0].status).toBe("done");
  });

  // Review wave 1: the rule keys on the sessions bound to the task (server
  // state), never only on the conversation_id the request claims.
  test("a hand bound to the task cannot close by omitting conversation_id", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await expect(done(ctx, undefined)).rejects.toThrow(/Independent review required/);
    expect(tables.tasks[0].status).toBe("in_review");
  });

  test("a hand bound to the task cannot close by claiming a session with no role", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await expect(done(ctx, "free")).rejects.toThrow(/Independent review required/);
  });

  test("a linked session that released the task (no active_task_id) is not doing the work", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    await done(ctx, undefined);
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a verdict from a session bound to the task is not independent, whatever its role", async () => {
    const { ctx } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1", "conversations_hand_s"], review_verdict: approveBy("conversations_hand_s") }));
    for (const id of ["conversations_hand_r1", "conversations_hand_s"]) {
      ctx.db._tables.conversations.find((c: any) => c._id === id).active_task_id = "tasks_1";
    }
    await expect(done(ctx, "hand-r1")).rejects.toThrow(/session doing the work/);
  });

  test("a changes verdict does not bind the reviewer to the task", async () => {
    const { ctx, tables } = await makeCtx(task());
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "free", review_verdict: "changes" });
    expect(tables.conversations.find((c: any) => c._id === "conversations_free").active_task_id).toBeUndefined();
  });

  test("--cascade holds each open subtask to the rule", async () => {
    const parent = task({ status: "in_review", review_verdict: approveBy("conversations_free") });
    const { ctx, tables } = await makeCtx(parent);
    tables.tasks.push({ _id: "tasks_2", short_id: "ct-2", title: "child", user_id: OWNER, status: "in_progress", parent_id: "tasks_1", conversation_ids: ["conversations_hand_r2"] });
    tables.conversations.find((c: any) => c._id === "conversations_hand_r2").active_task_id = "tasks_2";
    await expect(done(ctx, "free", { subtask_resolution: "cascade" })).rejects.toThrow(/ct-2 to done without an approve verdict/);
    expect(tables.tasks[0].status).toBe("in_review");
    expect(tables.tasks[1].status).toBe("in_progress");
  });

  // Final product review: a role that runs the line spawns its review
  // station as the task's reviewer (review_of_task_id), never as its own
  // hand. The reviewer approves and closes in one call while the role's
  // hand is still bound to the task.
  test("the review station approves and closes in one call while a hand of R is bound", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await done(ctx, "reviewer", { review_verdict: "approve", review_note: "all criteria met" });
    expect(tables.tasks[0].status).toBe("done");
    expect(tables.tasks[0].review_verdict).toMatchObject({ verdict: "approve", by_conversation_id: "conversations_reviewer" });
  });

  test("a reviewer that bound itself to the task is still the reviewer, not a session doing the work", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1", "conversations_reviewer"] }));
    for (const id of ["conversations_hand_r1", "conversations_reviewer"]) {
      tables.conversations.find((c: any) => c._id === id).active_task_id = "tasks_1";
    }
    await done(ctx, "reviewer", { review_verdict: "approve" });
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a roleless session approves and closes in one call while a hand of R is bound", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await done(ctx, "free", { review_verdict: "approve" });
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a hand of R approving R's bound work in one call is refused by role, even unbound itself", async () => {
    const { ctx } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    ctx.db._tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await expect(done(ctx, "hand-r2", { review_verdict: "approve" })).rejects.toThrow(/same role/);
  });

  test("a hand of S approving R's bound work in one call passes", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await done(ctx, "hand-s", { review_verdict: "approve" });
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a changes verdict sends the task back to in_progress", async () => {
    const { ctx, tables } = await makeCtx(task());
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "free", review_verdict: "changes" });
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.tasks[0].review_verdict.verdict).toBe("changes");
  });
});

// The web board goes through the same rule (final product review). A web
// write has a person behind it and no session, so its verdict is outside
// every role; without one, role work is refused exactly as on the CLI.
describe("tasks.webUpdate independent review", () => {
  const webDone = (ctx: any, extra: Record<string, any> = {}) =>
    (webUpdate as any)._handler(ctx, { short_id: "ct-1", status: "done", ...extra });

  test("a board close of role work still in progress, with no verdict, is refused", async () => {
    const { ctx, tables } = await makeCtx(task({ status: "in_progress", conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await expect(webDone(ctx)).rejects.toThrow(/Independent review required/);
    expect(tables.tasks[0].status).toBe("in_progress");
  });

  test("dragging role work from In Review to Done is the person's approve, recorded as such", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await webDone(ctx);
    expect(tables.tasks[0].status).toBe("done");
    expect(tables.tasks[0].review_verdict).toMatchObject({ verdict: "approve", note: "closed from the board" });
    expect(tables.tasks[0].review_verdict.by_conversation_id).toBeUndefined();
  });

  test("a board close with the person's approve records the verdict without a session and closes", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_hand_r1"] }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await webDone(ctx, { review_verdict: "approve", review_note: "checked on the board" });
    const row = tables.tasks[0];
    expect(row.status).toBe("done");
    expect(row.review_verdict).toMatchObject({ verdict: "approve", note: "checked on the board" });
    expect(row.review_verdict.by_conversation_id).toBeUndefined();
    expect(tables.task_history.some((h: any) => h.field === "review_verdict" && h.new_value === "approve")).toBe(true);
  });

  test("a board close from in progress on a stored verdict from R's own hand is refused", async () => {
    const { ctx, tables } = await makeCtx(task({ status: "in_progress", conversation_ids: ["conversations_hand_r1"], review_verdict: approveBy("conversations_hand_r2") }));
    tables.conversations.find((c: any) => c._id === "conversations_hand_r1").active_task_id = "tasks_1";
    await expect(webDone(ctx)).rejects.toThrow(/same role/);
  });

  test("a board close of work with no role behind it is unaffected", async () => {
    const { ctx, tables } = await makeCtx(task({ conversation_ids: ["conversations_free"] }));
    tables.conversations.find((c: any) => c._id === "conversations_free").active_task_id = "tasks_1";
    await webDone(ctx);
    expect(tables.tasks[0].status).toBe("done");
  });

  test("a board cascade holds each open subtask to the rule", async () => {
    const { ctx, tables } = await makeCtx(task({ review_verdict: { verdict: "approve", at: 1 } }));
    tables.tasks.push({ _id: "tasks_2", short_id: "ct-2", title: "child", user_id: OWNER, status: "in_progress", parent_id: "tasks_1", conversation_ids: ["conversations_hand_r2"] });
    tables.conversations.find((c: any) => c._id === "conversations_hand_r2").active_task_id = "tasks_2";
    await expect(webDone(ctx, { subtask_resolution: "cascade" })).rejects.toThrow(/ct-2 to done without an approve verdict/);
    expect(tables.tasks[1].status).toBe("in_progress");
  });
});
