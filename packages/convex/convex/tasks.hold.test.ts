// The hold (docs/architecture/the-line.md L5): a pending, blocking decision
// bound to a task at its current station keeps the task there. A session
// actor is refused; a person on the board moves past it and a note comment
// names the decision; answering the decision releases the hold.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { update, webUpdate, holdingDecisionFor } from "./tasks";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "hold-token";

const decision = (extra: Record<string, any> = {}) => ({
  _id: "session_decisions_1",
  short_id: "sd-211",
  conversation_id: "conversations_hand",
  session_id: "hand",
  user_id: OWNER,
  question: "Ship it?",
  options: [{ label: "Yes" }, { label: "No" }],
  blocking: true,
  status: "pending",
  task_id: "tasks_1",
  station: "in_review",
  created_at: 1,
  ...extra,
});

async function makeCtx(task: Record<string, any> = {}, decisions: any[] = [decision()]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner", github_username: "owner" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks: [{ _id: "tasks_1", short_id: "ct-1", title: "ct-1", user_id: OWNER, status: "in_review", source: "agent", ...task }],
    task_history: [],
    task_comments: [],
    thread_reads: [],
    entity_subscriptions: [],
    session_decisions: decisions,
    conversations: [{ _id: "conversations_hand", session_id: "hand", user_id: OWNER, status: "active" }],
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

const cliMove = (ctx: any, session: string | undefined, extra: Record<string, any> = {}) =>
  (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", ...(session ? { conversation_id: session } : {}), ...extra });
const boardMove = (ctx: any, extra: Record<string, any> = {}) =>
  (webUpdate as any)._handler(ctx, { short_id: "ct-1", status: "in_progress", ...extra });

describe("the hold (the-line.md L5)", () => {
  test("a hand cannot move a held task; the error names the decision and the release path", async () => {
    const { ctx, tables } = await makeCtx();
    await expect(cliMove(ctx, "hand")).rejects.toThrow("Held at in_review by sd-211: answer it first (cast decide answer sd-211 <n>)");
    expect(tables.tasks[0].status).toBe("in_review");
    expect(tables.task_comments).toHaveLength(0);
  });

  test("a person on the board moves past the hold; the decision stays open and a note names it", async () => {
    const { ctx, tables } = await makeCtx();
    await boardMove(ctx);
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.session_decisions[0].status).toBe("pending");
    const note = tables.task_comments.find((c: any) => c.comment_type === "note");
    expect(note?.text).toContain("sd-211");
    expect(note?.text).toContain("in_review");
    expect(note?.author_user_id).toBe(OWNER);
  });

  test("a person at the CLI with no session is a person too: allowed, with the note", async () => {
    const { ctx, tables } = await makeCtx();
    await cliMove(ctx, undefined);
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.task_comments.some((c: any) => c.comment_type === "note" && c.text.includes("sd-211"))).toBe(true);
  });

  test("answering releases the hold", async () => {
    const { ctx, tables } = await makeCtx({}, [decision({ status: "answered", answer_index: 0 })]);
    await cliMove(ctx, "hand");
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.task_comments).toHaveLength(0);
  });

  test("a non blocking decision does not hold", async () => {
    const { ctx, tables } = await makeCtx({}, [decision({ blocking: false, default_option: 0 })]);
    await cliMove(ctx, "hand");
    expect(tables.tasks[0].status).toBe("in_progress");
  });

  test("a decision at another station does not hold", async () => {
    const { ctx, tables } = await makeCtx({}, [decision({ station: "in_progress" })]);
    await cliMove(ctx, "hand");
    expect(tables.tasks[0].status).toBe("in_progress");
  });

  test("the station is the team status id when the task carries one", async () => {
    const { ctx, tables } = await makeCtx({ status_id: "qa" }, [decision({ station: "qa" })]);
    await expect(cliMove(ctx, "hand")).rejects.toThrow(/Held at qa by sd-211/);
    expect(tables.tasks[0].status).toBe("in_review");
  });

  test("a write that does not move the status is not held", async () => {
    const { ctx, tables } = await makeCtx();
    await cliMove(ctx, "hand", { status: undefined, title: "renamed" });
    expect(tables.tasks[0].title).toBe("renamed");
    expect(await holdingDecisionFor(ctx, tables.tasks[0], "in_review")).toBeNull();
    expect(await holdingDecisionFor(ctx, tables.tasks[0], undefined)).toBeNull();
  });
});
