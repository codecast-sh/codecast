// The web's Close (inboxStore closeSession / closeSessions) against its Kill:
// both stop the agent, but Close is "done looking at it", not retirement. Its
// triggers and queued messages stay, a role's own session closes without the
// seat refusal, and the next message or trigger brings it back.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { enqueuePendingMessage } from "./pendingMessages";

setDefaultTimeout(60_000);

async function setup(conv: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.db.insert("users", { emailVerificationTime: 1, name: "Riley" } as any);
    const role = await ctx.db.insert("org_roles", {
      short_id: "or-1", scope_type: "user", scope_user_id: user, host_user_id: user, name: "Infrastructure", handle: "infra",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: user }, status: "active", trust: "direct",
      caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
      created_by: user, created_at: now, updated_at: now,
    } as any);
    const c = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", started_at: now, updated_at: now, status: "active", session_id: "s-close", title: "Fix the build", message_count: 12,
      ...(conv.standing_role_id === "role" ? { ...conv, standing_role_id: role } : conv),
    } as any);
    const task = await ctx.db.insert("agent_tasks", { user_id: user, title: "check CI", prompt: "check CI", schedule_type: "once", mode: "apply", status: "scheduled", retry_count: 0, run_count: 0, created_at: now, run_at: now + 3_600_000, originating_conversation_id: c } as any);
    const queued = await ctx.db.insert("pending_messages", { conversation_id: c, from_user_id: user, content: "one more thing", status: "pending", created_at: now, retry_count: 0 } as any);
    return { user, conv: c, task, queued };
  });
  const send = (action: string, args: unknown[]) => {
    const now = Date.now();
    return t.withIdentity({ subject: `${ids.user}|test` }).mutation(api.dispatch.dispatch, {
      action, args, patches: { conversations: { [ids.conv]: { inbox_dismissed_at: now } } },
    });
  };
  const read = () => t.run(async (ctx) => ({
    conv: (await ctx.db.get(ids.conv)) as any,
    task: (await ctx.db.get(ids.task)) as any,
    queued: (await ctx.db.get(ids.queued)) as any,
    kills: (await ctx.db.query("daemon_commands").collect()).filter((c: any) => c.command === "kill_session"),
  }));
  return { t, ids, send, read };
}

describe("closeSession", () => {
  test("stops an ordinary session and keeps its armed trigger and queued message", async () => {
    const s = await setup();
    await s.send("closeSession", [String(s.ids.conv)]);
    const { conv, task, queued, kills } = await s.read();
    expect(conv.inbox_dismissed_at).toBeGreaterThan(0);
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(conv.status).toBe("completed");
    expect(kills.length).toBe(1);
    expect(task.status).toBe("scheduled");
    expect(task.canceled_on_kill_at).toBeUndefined();
    expect(queued.status).toBe("pending");
  });

  test("closeSessions (the bulk gesture) keeps them the same way", async () => {
    const s = await setup();
    await s.send("closeSessions", [[String(s.ids.conv)]]);
    const { conv, task, queued, kills } = await s.read();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(kills.length).toBe(1);
    expect(task.status).toBe("scheduled");
    expect(queued.status).toBe("pending");
  });

  test("closes a role's own session without the seat refusal", async () => {
    const s = await setup({ standing_role_id: "role" });
    await s.send("closeSession", [String(s.ids.conv)]);
    const { conv, task, kills } = await s.read();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(kills.length).toBe(1);
    expect(task.status).toBe("scheduled");
  });

  test("a message reaching a closed session brings it back", async () => {
    const s = await setup();
    await s.send("closeSession", [String(s.ids.conv)]);
    await s.t.run(async (ctx) => {
      const conv = await ctx.db.get(s.ids.conv);
      await enqueuePendingMessage(ctx, conv, s.ids.user, { content: "check CI", origin: "scheduler" });
    });
    const { conv } = await s.read();
    expect(conv.inbox_dismissed_at).toBeUndefined();
    expect(conv.inbox_killed_at).toBeUndefined();
    expect(conv.status).toBe("active");
  });
});

describe("killSession is still retirement", () => {
  test("a kill cancels the armed trigger and the queued message", async () => {
    const s = await setup();
    await s.send("killSession", [String(s.ids.conv)]);
    const { conv, task, queued, kills } = await s.read();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(kills.length).toBe(1);
    expect(task.status).not.toBe("scheduled");
    expect(task.canceled_on_kill_at).toBeGreaterThan(0);
    expect(queued.status).not.toBe("pending");
  });

  test("a kill of a role's own session is refused", async () => {
    const s = await setup({ standing_role_id: "role" });
    await expect(s.send("killSession", [String(s.ids.conv)])).rejects.toThrow(/@infra's own session/);
  });
});
