// tasks.update must not announce a self-assignment. Agents run under the
// owner's token, so an `assignee: "me"` from a CLI claim resolves to the owner;
// before this guard every agent claim notified the owner that they assigned
// themselves and enrolled them as assignee. webUpdate already had the guard;
// update mirrors it.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { update } from "./tasks";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const BOB = "users_bob";
const TOKEN = "self-assign-token";

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: OWNER, name: "Owner", github_username: "owner" },
      { _id: BOB, name: "Bob", github_username: "bob" },
    ],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_history: [],
    entity_subscriptions: [],
    conversations: [{ _id: "conversations_1", session_id: "sess-1", user_id: OWNER, status: "active" }],
  };
  const emitted: any[] = [];
  const subscribed: any[] = [];
  const db = makeFakeDb(tables);
  // Snapshot semantics: replace the row on patch so pre-patch reads stay stale.
  const patchInPlace = db.patch;
  db.patch = async (id: any, patch: any) => {
    for (const rows of Object.values(tables)) {
      const i = rows.findIndex((r: any) => String(r._id) === String(id));
      if (i >= 0) rows[i] = { ...rows[i] };
    }
    return patchInPlace(id, patch);
  };
  const ctx = {
    auth: { async getUserIdentity() { return null; } },
    db,
    scheduler: { runAfter: async () => null },
    async runMutation(_ref: unknown, args: any) {
      if (args && typeof args === "object") {
        if ("event_type" in args) emitted.push(args);
        if ("reason" in args) subscribed.push(args);
      }
      return null;
    },
  } as any;
  return { ctx, tables, emitted, subscribed };
}

const task = () => ({ _id: "tasks_1", short_id: "ct-1", title: "ct-1", user_id: OWNER, status: "open", source: "agent" });
const assigned = (emitted: any[]) => emitted.filter((e) => e.event_type === "task_assigned");

describe("tasks.update self-assign guard", () => {
  test("assignee 'me' resolves to the actor: no task_assigned, no assignee enrollment", async () => {
    const { ctx, tables, emitted, subscribed } = await makeCtx([task()]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", assignee: "me" });
    expect(tables.tasks[0].assignee).toBe(OWNER);
    expect(assigned(emitted)).toEqual([]);
    expect(subscribed.filter((s) => s.reason === "assignee")).toEqual([]);
  });

  test("assigning someone else still notifies and enrolls them", async () => {
    const { ctx, emitted, subscribed } = await makeCtx([task()]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", assignee: "bob" });
    expect(assigned(emitted).map((e) => e.direct_recipient_id)).toEqual([BOB]);
    expect(subscribed.filter((s) => s.reason === "assignee").map((s) => s.user_id)).toEqual([BOB]);
  });

  test("an agent claim (session binding, no assignee) leaves assignee unset", async () => {
    const { ctx, tables, emitted } = await makeCtx([task()]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "sess-1" });
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.tasks[0].assignee).toBeUndefined();
    expect(assigned(emitted)).toEqual([]);
  });
});
