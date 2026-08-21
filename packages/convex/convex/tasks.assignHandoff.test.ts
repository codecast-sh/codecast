// Assigning a task to someone ELSE is a handoff: the assigner's follow of the
// task thread ends. The mutation mutes the assigner (the durable marker every
// membership leg respects) and deletes their thread_reads row, so the card
// leaves their Threads inbox at once. Human acts only — an agent assigning
// under its owner's token must not silently unfollow the owner — and
// re-engagement (ensureSubscribed) clears the mute.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { batchAssign, create, update, webUpdate } from "./tasks";
import { ensureSubscribed, setSubscriptionMuted } from "./notificationRouter";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const BOB = "users_bob";
const TOKEN = "handoff-test-token";

async function makeCtx(tasks: any[] = [], threadReads: any[] = []) {
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
    thread_reads: threadReads,
    counters: [],
    conversations: [{ _id: "conversations_1", session_id: "sess-1", user_id: OWNER, status: "active" }],
  };
  const muted: any[] = [];
  const subscribed: any[] = [];
  const db = makeFakeDb(tables);
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
      if (args && typeof args === "object") {
        // ensureSubscribed carries `reason`; setSubscriptionMuted carries `muted`.
        if ("reason" in args) subscribed.push(args);
        else if ("muted" in args) muted.push(args);
      }
      return null;
    },
  } as any;
  return { ctx, tables, muted, subscribed };
}

const task = (shortId: string, over: any = {}) => ({
  _id: `tasks_${shortId}`,
  short_id: shortId,
  title: shortId,
  user_id: OWNER,
  status: "open",
  source: "human",
  ...over,
});

const ownerRead = (taskId: string) => ({
  _id: `tr_${taskId}`,
  user_id: OWNER,
  kind: "task",
  root_key: taskId,
  last_activity_at: 100,
  last_read_at: 0,
  updated_at: 100,
});

describe("assigning to someone else hands the thread off", () => {
  test("webUpdate: the assigner is muted and their thread row is dropped", async () => {
    const { ctx, tables, muted } = await makeCtx([task("ct-1")], [ownerRead("tasks_ct-1")]);
    await (webUpdate as any)._handler(ctx, { short_id: "ct-1", assignee: "bob" });
    expect(muted).toEqual([
      { user_id: OWNER, entity_type: "task", entity_id: "tasks_ct-1", muted: true },
    ]);
    expect(tables.thread_reads).toEqual([]);
  });

  test("CLI update by hand hands off; the same call from inside a session does not", async () => {
    const { ctx, tables, muted } = await makeCtx(
      [task("ct-1"), task("ct-2")],
      [ownerRead("tasks_ct-1"), ownerRead("tasks_ct-2")],
    );
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", assignee: "bob" });
    expect(muted).toHaveLength(1);
    expect(tables.thread_reads.map((r: any) => r.root_key)).toEqual(["tasks_ct-2"]);

    await (update as any)._handler(ctx, {
      api_token: TOKEN, short_id: "ct-2", assignee: "bob", conversation_id: "sess-1",
    });
    expect(muted).toHaveLength(1);
    expect(tables.thread_reads.map((r: any) => r.root_key)).toEqual(["tasks_ct-2"]);
  });

  test("batchAssign hands off every task it assigns away", async () => {
    const { ctx, tables, muted } = await makeCtx(
      [task("ct-1"), task("ct-2")],
      [ownerRead("tasks_ct-1"), ownerRead("tasks_ct-2")],
    );
    await (batchAssign as any)._handler(ctx, { api_token: TOKEN, short_ids: ["ct-1", "ct-2"], assignee: "bob" });
    expect(muted).toHaveLength(2);
    expect(tables.thread_reads).toEqual([]);
  });

  test("create with an assignee mutes the creator, so the stream never files for them", async () => {
    const { ctx, muted } = await makeCtx();
    await (create as any)._handler(ctx, { api_token: TOKEN, title: "for bob", assignee: "bob" });
    expect(muted).toEqual([
      expect.objectContaining({ user_id: OWNER, muted: true }),
    ]);
  });

  test("assigning yourself, or an agent label, is no handoff", async () => {
    const { ctx, tables, muted } = await makeCtx(
      [task("ct-1"), task("ct-2")],
      [ownerRead("tasks_ct-1"), ownerRead("tasks_ct-2")],
    );
    await (webUpdate as any)._handler(ctx, { short_id: "ct-1", assignee: "owner" });
    await (webUpdate as any)._handler(ctx, { short_id: "ct-2", assignee: "agent:codex" });
    expect(muted).toEqual([]);
    expect(tables.thread_reads).toHaveLength(2);
  });
});

describe("the mute marker: written by setSubscriptionMuted, cleared by re-engagement", () => {
  const base = { user_id: OWNER as any, entity_type: "task" as const, entity_id: "tasks_1" };

  test("no subscription row: muting files a muted watching row; unmuting files nothing", async () => {
    const db = makeFakeDb({ entity_subscriptions: [] });
    const ctx = { db } as any;
    await (setSubscriptionMuted as any)._handler(ctx, { ...base, muted: false });
    expect(db._tables.entity_subscriptions).toEqual([]);
    await (setSubscriptionMuted as any)._handler(ctx, { ...base, muted: true });
    expect(db._tables.entity_subscriptions).toEqual([
      expect.objectContaining({ user_id: OWNER, reason: "watching", muted: true }),
    ]);
  });

  test("an existing row is patched in place, whatever its reason", async () => {
    const db = makeFakeDb({
      entity_subscriptions: [{ _id: "s1", ...base, reason: "creator", via: "human", muted: false, created_at: 1 }],
    });
    const ctx = { db } as any;
    await (setSubscriptionMuted as any)._handler(ctx, { ...base, muted: true });
    expect(db._tables.entity_subscriptions[0]).toMatchObject({ reason: "creator", muted: true });
  });

  test("re-engagement unmutes: a human act of one's own, or being assigned or mentioned by anyone; an agent comment never", async () => {
    const row = (muted: boolean) => ({ _id: "s1", ...base, reason: "creator", via: "human", muted, created_at: 1 });
    const drive = async (seed: any, call: any) => {
      const db = makeFakeDb({ entity_subscriptions: [seed] });
      await (ensureSubscribed as any)._handler({ db } as any, { ...base, ...call });
      return db._tables.entity_subscriptions[0].muted;
    };
    expect(await drive(row(true), { reason: "commenter", via: "human" })).toBe(false);
    expect(await drive(row(true), { reason: "assignee", via: "agent" })).toBe(false);
    expect(await drive(row(true), { reason: "mentioned", via: "agent" })).toBe(false);
    expect(await drive(row(true), { reason: "commenter", via: "agent" })).toBe(true);
    expect(await drive(row(true), { reason: "creator" })).toBe(true);
  });
});
