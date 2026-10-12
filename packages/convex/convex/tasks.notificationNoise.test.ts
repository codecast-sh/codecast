// The bell reaches the same people the Threads inbox does, for the same
// reasons: a person's comment, an agent comment that needs a person, a close
// the reader opted into, and one row per burst of machine assignments. These
// pin each rule against the real handlers (subscribe, emit) on a fake db.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addComment, update } from "./tasks";
import { emit, ensureSubscribed } from "./notificationRouter";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const BOB = "users_bob";
const CAROL = "users_carol";
const BOT = "users_bot";
const TOKEN = "noise-owner-token";
const BOT_TOKEN = "noise-bot-token";

async function makeCtx(over: { bobPrefs?: any } = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: OWNER, name: "Owner", github_username: "owner" },
      { _id: BOB, name: "Bob", github_username: "bob", ...(over.bobPrefs ? { notification_preferences: over.bobPrefs } : {}) },
      { _id: CAROL, name: "Carol", github_username: "carol" },
      { _id: BOT, name: "Aivery", is_bot: true },
    ],
    api_tokens: [
      { _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) },
      { _id: "token_2", user_id: BOT, token_hash: await hashToken(BOT_TOKEN) },
    ],
    tasks: ["ct-1", "ct-2", "ct-3"].map((id) => ({ _id: `tasks_${id}`, short_id: id, title: id, user_id: OWNER, status: "open", source: "agent", team_id: "teams_1", workspace: "team:teams_1" })),
    teams: [{ _id: "teams_1", name: "Team" }],
    team_memberships: [OWNER, BOB, CAROL, BOT].map((user_id, i) => ({ _id: `m${i}`, user_id, team_id: "teams_1", role: "member" })),
    task_comments: [],
    task_history: [],
    notifications: [],
    thread_reads: [],
    counters: [],
    // Bob followed ct-1 by his own hand; Carol was enrolled by her agent.
    entity_subscriptions: [
      { _id: "sub_bob", user_id: BOB, entity_type: "task", entity_id: "tasks_ct-1", reason: "commenter", via: "human", muted: false, created_at: 0 },
      { _id: "sub_carol", user_id: CAROL, entity_type: "task", entity_id: "tasks_ct-1", reason: "commenter", via: "agent", muted: false, created_at: 0 },
    ],
    conversations: [{ _id: "conversations_1", session_id: "sess-1", user_id: OWNER, status: "active" }],
  };
  const db = makeFakeDb(tables);
  const ctx: any = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
    scheduler: { runAfter: async () => null },
    async runMutation(_ref: unknown, args: any) {
      if (args && "event_type" in args) return (emit as any)._handler(ctx, args);
      if (args && "reason" in args) return (ensureSubscribed as any)._handler(ctx, args);
      return null;
    },
  };
  const bell = (type: string, who?: string) =>
    tables.notifications.filter((n) => n.type === type && (!who || n.recipient_user_id === who));
  return { ctx, tables, bell };
}

describe("task comments ring whom the Threads inbox files them for", () => {
  test("a person's comment reaches followers by their own hand, not ones an agent enrolled", async () => {
    const { ctx, bell } = await makeCtx();
    await (addComment as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", text: "looks good" });
    expect(bell("task_commented").map((n) => n.recipient_user_id)).toEqual([BOB]);
  });

  test("an agent's progress note rings nobody; its blocker rings the followers", async () => {
    const { ctx, bell } = await makeCtx();
    await (addComment as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", text: "rebased", conversation_id: "sess-1" });
    expect(bell("task_commented")).toHaveLength(0);
    await (addComment as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", text: "need a prod key", comment_type: "blocker", conversation_id: "sess-1" });
    expect(bell("task_commented").map((n) => n.recipient_user_id)).toEqual([BOB]);
  });

  test("on an ephemeral task only a blocker or an @mention rings (TG9)", async () => {
    const { ctx, tables, bell } = await makeCtx();
    tables.tasks[0].ephemeral = true;
    await (addComment as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", text: "looks good" });
    expect(bell("task_commented")).toHaveLength(0);
    await (addComment as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", text: "@carol this needs your approval" });
    expect(bell("task_commented").map((n) => n.recipient_user_id)).toEqual([CAROL]);
    await (addComment as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", text: "need a prod key", comment_type: "blocker", conversation_id: "sess-1" });
    expect(bell("task_commented", BOB)).toHaveLength(1);
  });

  test("a bot account's note counts as an agent's even from a terminal", async () => {
    const { ctx, bell } = await makeCtx();
    await (addComment as any)._handler(ctx, { api_token: BOT_TOKEN, short_id: "ct-1", text: "READY FOR DECISION: waited 18 days" });
    expect(bell("task_commented")).toHaveLength(0);
  });
});

describe("status changes are quiet unless the reader opts into closes", () => {
  test("no status move rings by default", async () => {
    const { ctx, bell } = await makeCtx();
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress" });
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "done" });
    expect(bell("task_status_changed")).toHaveLength(0);
  });

  test("an opted-in participant hears done, not in_progress", async () => {
    const { ctx, bell } = await makeCtx({ bobPrefs: { team_session_start: true, mention: true, permission_request: true, task_status_changes: true } });
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress" });
    expect(bell("task_status_changed")).toHaveLength(0);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "done" });
    expect(bell("task_status_changed").map((n) => n.recipient_user_id)).toEqual([BOB]);
  });
});

describe("machine assignment bursts fold into one row", () => {
  test("a bot assigning three tasks leaves one unread row that counts them", async () => {
    const { ctx, bell } = await makeCtx();
    for (const id of ["ct-1", "ct-2", "ct-3"]) {
      await (update as any)._handler(ctx, { api_token: BOT_TOKEN, short_id: id, assignee: "bob" });
    }
    const rows = bell("task_assigned", BOB);
    expect(rows).toHaveLength(1);
    expect(rows[0].fold_count).toBe(3);
    expect(rows[0].message).toContain("assigned you 3 tasks, latest ct-3");
  });

  test("a person assigning by hand still gets one row per task", async () => {
    const { ctx, bell } = await makeCtx();
    for (const id of ["ct-1", "ct-2"]) {
      await (update as any)._handler(ctx, { api_token: TOKEN, short_id: id, assignee: "bob" });
    }
    expect(bell("task_assigned", BOB)).toHaveLength(2);
  });
});
