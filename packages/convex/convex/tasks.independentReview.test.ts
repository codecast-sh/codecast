// Independent review (docs/architecture/the-line.md L3): a session filed under
// an org role cannot move a task to done without an approve verdict from
// outside that role. tasks.update is the one status mutation the CLI uses
// (cast task done / handoff / verdict), so the rule lives there.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { update } from "./tasks";
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
    auth: { async getUserIdentity() { return null; } },
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

  test("a hand cannot close on its own approve, even written in the same call", async () => {
    const { ctx } = await makeCtx(task());
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

  test("a changes verdict sends the task back to in_progress", async () => {
    const { ctx, tables } = await makeCtx(task());
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "free", review_verdict: "changes" });
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.tasks[0].review_verdict.verdict).toBe("changes");
  });
});
