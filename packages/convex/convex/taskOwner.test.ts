// A task has one owning session (lib/taskOwner.ts), under convex-test:
// `cast task start` from a second session is refused while the owner is still
// working, --take moves the binding and says so, a quiet owner is released
// without asking, and a start moves a session's own focus off its old task.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";

const TOKEN = "o".repeat(64);
const HOUR = 3_600_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./tasks.ts": () => import("./tasks"),
};

async function setup(ownerUpdatedAgo: number) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Owner" } as any);
    await ctx.db.insert("api_tokens", { user_id: userId, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const conv = (sessionId: string, shortId: string, updatedAt: number) => ctx.db.insert("conversations", {
      user_id: userId, agent_type: "claude_code", session_id: sessionId, short_id: shortId, title: `session ${shortId}`,
      started_at: now - 2 * HOUR, updated_at: updatedAt, message_count: 3, is_private: true, status: "active", project_path: "/repo",
    } as any);
    const task = (shortId: string) => ctx.db.insert("tasks", {
      user_id: userId, workspace: `user:${userId}`, short_id: shortId, title: `task ${shortId}`,
      task_type: "task", status: "open", priority: "medium", blocks: [], source: "human",
      attempt_count: 0, retry_count: 0, max_retries: 3, created_at: now, updated_at: now,
    } as any);
    const ownerId = await conv("sess-owner", "jx7aaaa", now - ownerUpdatedAgo);
    const otherId = await conv("sess-other", "jx7bbbb", now);
    const taskId = await task("ct-1");
    const elsewhereId = await task("ct-2");
    await ctx.db.patch(taskId, { conversation_ids: [ownerId] } as any);
    await ctx.db.patch(ownerId, { active_task_id: taskId } as any);
    return { userId, ownerId, otherId, taskId, elsewhereId };
  });
  const get = (id: any) => t.run(async (ctx) => await ctx.db.get(id)) as Promise<any>;
  const start = (sessionId: string, shortId = "ct-1", take?: boolean) =>
    t.mutation(api.tasks.update, { api_token: TOKEN, short_id: shortId, status: "in_progress", conversation_id: sessionId, ...(take ? { take } : {}) });
  return { t, ...ids, get, start };
}

setDefaultTimeout(30_000);

describe("one owning session per task", () => {
  test("a second session is refused while the owner is still working, and nothing moves", async () => {
    const { ownerId, otherId, get, start } = await setup(60_000);
    await expect(start("sess-other")).rejects.toThrow(/owned by session jx7aaaa[\s\S]*cast send jx7aaaa[\s\S]*--take/);
    expect(String((await get(ownerId)).active_task_id)).not.toBe("undefined");
    expect((await get(otherId)).active_task_id).toBeUndefined();
  });

  test("--take moves the binding, names the working owner, and leaves a note on the task", async () => {
    const { t, ownerId, otherId, taskId, get, start } = await setup(60_000);
    const out: any = await start("sess-other", "ct-1", true);
    expect(out.released_owners).toEqual([{ short_id: "jx7aaaa", title: "session jx7aaaa", live: true }]);
    expect((await get(ownerId)).active_task_id).toBeUndefined();
    expect(String((await get(otherId)).active_task_id)).toBe(String(taskId));
    const notes = await t.run(async (ctx) => await ctx.db.query("task_comments").collect());
    expect(notes.map((c: any) => c.text)).toEqual(["Session jx7bbbb took over as owner from jx7aaaa."]);
  });

  test("a quiet owner is released without asking", async () => {
    const { ownerId, otherId, taskId, get, start } = await setup(3 * HOUR);
    const out: any = await start("sess-other");
    expect(out.released_owners).toEqual([{ short_id: "jx7aaaa", title: "session jx7aaaa", live: false }]);
    expect((await get(ownerId)).active_task_id).toBeUndefined();
    expect(String((await get(otherId)).active_task_id)).toBe(String(taskId));
  });

  test("the owner restarting its own task is no takeover", async () => {
    const { start } = await setup(60_000);
    const out: any = await start("sess-owner");
    expect(out.released_owners).toBeUndefined();
  });

  test("a start moves the session's own focus off the task it held before", async () => {
    const { ownerId, elsewhereId, get, start } = await setup(60_000);
    await start("sess-owner", "ct-2");
    expect(String((await get(ownerId)).active_task_id)).toBe(String(elsewhereId));
  });
});
