import { describe, expect, test } from "bun:test";
import { hashToken } from "./apiTokens";
import { makeFakeDb } from "./testDb";
import { addComment, context, get, webGet, webGetByIds } from "./tasks";
import { webGetTaskDetail } from "./taskMining";
import { attachCommentSessionInfo } from "./lib/commentSessionInfo";
import { restoreSessionAuthor } from "./taskCommentRepair";

const OWNER = "users_owner";
const MEMBER = "users_member";
const TEAM = "teams_one";
const TOKEN = "comment-author-token";
const TASK = "tasks_one";
const CONVERSATION = "conversations_codex";

async function fixture() {
  const tables = {
    users: [{ _id: OWNER, name: "Owner" }, { _id: MEMBER, name: "Member" }],
    api_tokens: [{ _id: "tokens_one", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks: [{ _id: TASK, short_id: "ct-1", title: "Task", user_id: OWNER, workspace: `team:${TEAM}`, team_id: TEAM, status: "open" }],
    conversations: [{ _id: CONVERSATION, session_id: "codex-thread", title: "Cast browser routing", agent_type: "codex", user_id: OWNER, is_private: true, status: "active" }],
    team_memberships: [{ _id: "memberships_owner", user_id: OWNER, team_id: TEAM }, { _id: "memberships_member", user_id: MEMBER, team_id: TEAM }],
    task_comments: [] as any[],
  };
  const db = makeFakeDb(tables);
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) },
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
    runQuery: async () => null,
  } as any;
  await (addComment as any)._handler(ctx, {
    api_token: TOKEN, short_id: "ct-1", text: "Browser pairing recovered", author: "Claude", conversation_id: "codex-thread",
  });
  return { ctx, tables };
}

describe("task comment session authors", () => {
  test("a private Codex session remains the author of a team task comment without binding the task", async () => {
    const { tables } = await fixture();
    expect(tables.task_comments[0].conversation_id).toBe(CONVERSATION);
    expect(tables.tasks[0]).not.toHaveProperty("conversation_ids");
    expect(tables.conversations[0].is_private).toBe(true);
  });

  const readers = {
    "task detail": async (ctx: any) => (await (webGetTaskDetail as any)._handler(ctx, { id: "ct-1" })).comments,
    "task reference": async (ctx: any) => (await (webGet as any)._handler(ctx, { short_id: "ct-1" })).comments,
    "change feed": async (ctx: any) => (await (webGetByIds as any)._handler(ctx, { ids: [TASK] })).items[0].comments,
    "CLI show": async (ctx: any) => (await (get as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1" })).comments,
    "CLI context": async (ctx: any) => (await (context as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1" })).comments,
  };

  for (const [name, read] of Object.entries(readers)) {
    test(`${name} shows the session title and Codex identity to its owner`, async () => {
      const { ctx } = await fixture();
      const [comment] = await read(ctx);
      expect(comment.session_info).toEqual({ _id: CONVERSATION, session_id: "codex-thread", title: "Cast browser routing", agent_type: "codex" });
    });

    test(`${name} hides the private session from another task viewer`, async () => {
      const { ctx, tables } = await fixture();
      tables.api_tokens[0].user_id = MEMBER;
      ctx.auth.getUserIdentity = async () => ({ subject: `${MEMBER}|session` });
      const [comment] = await read(ctx);
      expect(comment.text).toBe("Browser pairing recovered");
      expect(comment.session_info).toBeNull();
      expect(comment.conversation_id).toBeUndefined();
    });
  }

  test("deleted sessions and human comments render without a session link", async () => {
    const { ctx } = await fixture();
    const result = await attachCommentSessionInfo(ctx, [{ conversation_id: "conversations_deleted" as any }, {}], OWNER as any);
    expect(result).toEqual([{ conversation_id: undefined, session_info: null }, { conversation_id: undefined, session_info: null }]);
  });

  test("the evidence-based repair previews first, then restores the original comment without duplicating it", async () => {
    const { ctx, tables } = await fixture();
    delete tables.task_comments[0].conversation_id;
    const args = { comment_id: tables.task_comments[0]._id, conversation_id: CONVERSATION, expected_text: "Browser pairing recovered" };
    await (restoreSessionAuthor as any)._handler(ctx, args);
    expect(tables.task_comments[0].conversation_id).toBeUndefined();
    await (restoreSessionAuthor as any)._handler(ctx, { ...args, dry_run: false });
    await (restoreSessionAuthor as any)._handler(ctx, { ...args, dry_run: false });
    expect(tables.task_comments).toHaveLength(1);
    expect(tables.task_comments[0].conversation_id).toBe(CONVERSATION);
    expect(tables.tasks[0]).toHaveProperty("last_comment_at");
  });

  test("the repair refuses changed evidence, human comments, and an existing different author", async () => {
    const { ctx, tables } = await fixture();
    const args = { comment_id: tables.task_comments[0]._id, conversation_id: CONVERSATION, expected_text: "wrong text", dry_run: false };
    await expect((restoreSessionAuthor as any)._handler(ctx, args)).rejects.toThrow("evidence");
    args.expected_text = tables.task_comments[0].text;
    tables.task_comments[0].author_user_id = OWNER;
    await expect((restoreSessionAuthor as any)._handler(ctx, args)).rejects.toThrow("evidence");
    delete tables.task_comments[0].author_user_id;
    tables.task_comments[0].conversation_id = "conversations_other";
    await expect((restoreSessionAuthor as any)._handler(ctx, args)).rejects.toThrow("different author");
  });
});
