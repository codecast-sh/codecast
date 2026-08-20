// entity_subscriptions.via says who performed the enrolling act. Agents run
// under the owner's API token, so identity alone cannot tell a person's act
// from an agent's; every subscribeUser call site states it. These tests pin
// the stamp each call site sends and the upgrade rule in ensureSubscribed.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addComment, batchAssign, create, update, webAddComment, webUpdate } from "./tasks";
import { ensureSubscribed } from "./notificationRouter";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const BOB = "users_bob";
const TOKEN = "via-test-token";

async function makeCtx(tasks: any[] = []) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: OWNER, name: "Owner", github_username: "owner" },
      { _id: BOB, name: "Bob", github_username: "bob" },
    ],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_comments: [],
    task_history: [],
    entity_subscriptions: [],
    counters: [],
    // A session the agent acts from: conversation_id on a CLI call resolves here.
    conversations: [{ _id: "conversations_1", session_id: "sess-1", user_id: OWNER, status: "active" }],
  };
  const subscribed: any[] = [];
  const db = makeFakeDb(tables);
  // Real Convex hands handlers a snapshot; the fake db patches the row in
  // place, so a "did the assignee change" check after the patch would see the
  // new value. Replace the row object instead so earlier reads stay snapshots.
  const patchInPlace = db.patch;
  db.patch = async (id: any, patch: any) => {
    for (const rows of Object.values(tables)) {
      const i = rows.findIndex((r: any) => String(r._id) === String(id));
      if (i >= 0) rows[i] = { ...rows[i] };
    }
    return patchInPlace(id, patch);
  };
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
    scheduler: { runAfter: async () => null },
    async runMutation(_ref: unknown, args: any) {
      // ensureSubscribed is the only routed mutation carrying `reason`.
      if (args && typeof args === "object" && "reason" in args) subscribed.push(args);
      return null;
    },
  } as any;
  return { ctx, tables, subscribed };
}

const task = (shortId: string, over: any = {}) => ({
  _id: `tasks_${shortId}`,
  short_id: shortId,
  title: shortId,
  user_id: OWNER,
  status: "open",
  source: "agent",
  ...over,
});

const stamp = (subscribed: any[], reason: string, userId = OWNER) =>
  subscribed.filter((s) => s.reason === reason && s.user_id === userId).map((s) => s.via);

describe("create: creator enrollment follows task origin", () => {
  test("a CLI create with no source is human origin, so the creator is human", async () => {
    const { ctx, subscribed } = await makeCtx();
    await (create as any)._handler(ctx, { api_token: TOKEN, title: "t" });
    expect(stamp(subscribed, "creator")).toEqual(["human"]);
  });

  test("an agent-origin create enrolls its owner as an agent act", async () => {
    const { ctx, subscribed } = await makeCtx();
    await (create as any)._handler(ctx, { api_token: TOKEN, title: "t", source: "agent", conversation_id: "sess-1" });
    expect(stamp(subscribed, "creator")).toEqual(["agent"]);
  });

  test("meeting origin and promotion both count as a person deciding", async () => {
    const a = await makeCtx();
    await (create as any)._handler(a.ctx, { api_token: TOKEN, title: "t", source: "meeting" });
    expect(stamp(a.subscribed, "creator")).toEqual(["human"]);
    const b = await makeCtx();
    await (create as any)._handler(b.ctx, { api_token: TOKEN, title: "t", source: "agent", promoted: true });
    expect(stamp(b.subscribed, "creator")).toEqual(["human"]);
  });

  test("assignee at create carries the actor's kind, not the task origin", async () => {
    const { ctx, subscribed } = await makeCtx();
    await (create as any)._handler(ctx, { api_token: TOKEN, title: "t", source: "agent", assignee: "bob", conversation_id: "sess-1" });
    expect(stamp(subscribed, "assignee", BOB)).toEqual(["agent"]);
    const byHand = await makeCtx();
    await (create as any)._handler(byHand.ctx, { api_token: TOKEN, title: "t", source: "agent", assignee: "bob" });
    expect(stamp(byHand.subscribed, "assignee", BOB)).toEqual(["human"]);
  });
});

describe("CLI update, comment, batchAssign", () => {
  test("update assignee: a session call is agent, a terminal call is human", async () => {
    const a = await makeCtx([task("ct-1")]);
    await (update as any)._handler(a.ctx, { api_token: TOKEN, short_id: "ct-1", assignee: "bob", conversation_id: "sess-1" });
    expect(stamp(a.subscribed, "assignee", BOB)).toEqual(["agent"]);
    const b = await makeCtx([task("ct-1")]);
    await (update as any)._handler(b.ctx, { api_token: TOKEN, short_id: "ct-1", assignee: "bob" });
    expect(stamp(b.subscribed, "assignee", BOB)).toEqual(["human"]);
  });

  test("addComment: conversation_id marks the commenter as an agent act", async () => {
    const a = await makeCtx([task("ct-1")]);
    await (addComment as any)._handler(a.ctx, { api_token: TOKEN, short_id: "ct-1", text: "x", conversation_id: "sess-1" });
    expect(stamp(a.subscribed, "commenter")).toEqual(["agent"]);
    const b = await makeCtx([task("ct-1")]);
    await (addComment as any)._handler(b.ctx, { api_token: TOKEN, short_id: "ct-1", text: "x" });
    expect(stamp(b.subscribed, "commenter")).toEqual(["human"]);
  });

  test("batchAssign is a person at the terminal", async () => {
    const { ctx, subscribed } = await makeCtx([task("ct-1"), task("ct-2")]);
    await (batchAssign as any)._handler(ctx, { api_token: TOKEN, short_ids: ["ct-1", "ct-2"], assignee: "bob" });
    expect(stamp(subscribed, "assignee", BOB)).toEqual(["human", "human"]);
  });
});

describe("web mutations are human acts", () => {
  test("webAddComment stamps human", async () => {
    const { ctx, subscribed } = await makeCtx([task("ct-1")]);
    await (webAddComment as any)._handler(ctx, { short_id: "ct-1", text: "hi" });
    expect(stamp(subscribed, "commenter")).toEqual(["human"]);
  });

  test("webUpdate assignee stamps human for the assignee", async () => {
    const { ctx, subscribed } = await makeCtx([task("ct-1")]);
    await (webUpdate as any)._handler(ctx, { short_id: "ct-1", assignee: BOB });
    expect(stamp(subscribed, "assignee", BOB)).toEqual(["human"]);
  });
});

describe("ensureSubscribed stores via and only ever upgrades", () => {
  const base = { user_id: OWNER as any, entity_type: "task" as const, entity_id: "tasks_1", reason: "commenter" as const };
  const rows = (ctx: any) => ctx.db._tables.entity_subscriptions as any[];

  test("a new row stores the stamp; a legacy write stores none", async () => {
    const { ctx } = await makeCtx();
    await (ensureSubscribed as any)._handler(ctx, { ...base, via: "agent" });
    expect(rows(ctx)[0].via).toBe("agent");
    await (ensureSubscribed as any)._handler(ctx, { ...base, entity_id: "tasks_2" });
    expect(rows(ctx)[1].via).toBeUndefined();
  });

  test("a human act upgrades an agent or legacy row; an agent act never downgrades", async () => {
    const { ctx } = await makeCtx();
    await (ensureSubscribed as any)._handler(ctx, { ...base, via: "agent" });
    await (ensureSubscribed as any)._handler(ctx, { ...base, via: "human" });
    expect(rows(ctx)[0].via).toBe("human");
    await (ensureSubscribed as any)._handler(ctx, { ...base, via: "agent" });
    expect(rows(ctx)[0].via).toBe("human");
    expect(rows(ctx).length).toBe(1);

    await (ensureSubscribed as any)._handler(ctx, { ...base, entity_id: "tasks_2" });
    await (ensureSubscribed as any)._handler(ctx, { ...base, entity_id: "tasks_2", via: "human" });
    expect(rows(ctx)[1].via).toBe("human");
  });
});
