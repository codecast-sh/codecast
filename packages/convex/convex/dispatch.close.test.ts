// The web's Close (inboxStore closeSession / closeSessions) against its Kill.
// Close is dormancy, not retirement: it stops an agent only when nothing is in
// flight (the server rechecks, lib/closeAside), keeps its triggers and queue,
// stamps no retirement marker (only inbox_dismissed_at), closes a role's own
// session without the seat refusal, and the next message or trigger brings it
// back. Kill still retires.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { enqueuePendingMessage, performSessionSend } from "./pendingMessages";

setDefaultTimeout(60_000);

type Setup = { role?: boolean; conv?: Record<string, unknown>; queued?: boolean; agent?: string; newest?: Record<string, unknown> };

async function setup(o: Setup = {}) {
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
      user_id: user, agent_type: "claude_code", started_at: now, updated_at: now - 3_600_000, status: "active", session_id: "s-close", short_id: "jx7clos",
      title: "Fix the build", message_count: 12, last_message_role: "assistant",
      ...(o.role ? { standing_role_id: role } : {}),
      ...(o.queued ? { has_pending_messages: true } : {}),
      ...o.conv,
    } as any);
    if (o.agent) {
      await ctx.db.insert("managed_sessions", { session_id: "s-close", conversation_id: c, user_id: user, pid: 1, started_at: now - 3_600_000, last_heartbeat: now, agent_status: o.agent, agent_status_updated_at: now } as any);
    }
    if (o.newest) await ctx.db.insert("messages", { conversation_id: c, role: "assistant", content: "", timestamp: now, ...o.newest } as any);
    const task = await ctx.db.insert("agent_tasks", { user_id: user, title: "check CI", prompt: "check CI", schedule_type: "once", mode: "apply", status: "scheduled", retry_count: 0, run_count: 0, created_at: now, run_at: now + 3_600_000, originating_conversation_id: c } as any);
    const queued = await ctx.db.insert("pending_messages", { conversation_id: c, from_user_id: user, content: "one more thing", status: "pending", created_at: now, retry_count: 0 } as any);
    return { user, role, conv: c, task, queued };
  });
  const as = t.withIdentity({ subject: `${ids.user}|test` });
  const send = (action: string, args: unknown[], patches?: Record<string, Record<string, unknown>>) => {
    const now = Date.now();
    return as.mutation(api.dispatch.dispatch, { action, args, patches: { conversations: patches ?? { [ids.conv]: { inbox_dismissed_at: now } } } });
  };
  const kills = () => t.run(async (ctx) => (await ctx.db.query("daemon_commands").collect()).filter((c: any) => c.command === "kill_session"));
  const read = () => t.run(async (ctx) => ({
    conv: (await ctx.db.get(ids.conv)) as any,
    task: (await ctx.db.get(ids.task)) as any,
    queued: (await ctx.db.get(ids.queued)) as any,
    kills: (await ctx.db.query("daemon_commands").collect()).filter((c: any) => c.command === "kill_session"),
  }));
  return { t, ids, as, send, read, kills };
}

// Closed: dismissed, torn down, and nothing that reads as retired.
function expectClosed(r: { conv: any; task: any; kills: any[] }) {
  expect(r.conv.inbox_dismissed_at).toBeGreaterThan(0);
  expect(r.conv.inbox_killed_at).toBeUndefined();
  expect(r.conv.status).not.toBe("completed");
  expect(r.kills.length).toBe(1);
  expect(r.task.status).toBe("scheduled");
  expect(r.task.canceled_on_kill_at).toBeUndefined();
}
// Set aside: stashed, nothing stopped.
function expectAside(r: { conv: any; kills: any[] }) {
  expect(r.conv.inbox_stashed_at).toBeGreaterThan(0);
  expect(r.conv.inbox_dismissed_at).toBeUndefined();
  expect(r.conv.inbox_killed_at).toBeUndefined();
  expect(r.kills.length).toBe(0);
}

describe("closeSession stops what has nothing in flight", () => {
  test("an ordinary idle session is stopped and keeps its armed trigger and queued message", async () => {
    const s = await setup({ agent: "idle" });
    await s.send("closeSession", [String(s.ids.conv)]);
    const r = await s.read();
    expectClosed(r);
    expect(r.queued.status).toBe("pending");
  });

  test("closeSessions (the bulk gesture) does the same", async () => {
    const s = await setup();
    await s.send("closeSessions", [[String(s.ids.conv)]]);
    expectClosed(await s.read());
  });

  test("a role's own session closes without the seat refusal", async () => {
    const s = await setup({ role: true });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectClosed(await s.read());
  });

  test("a persistent anchor closes the same way: stopped, its trigger kept, no retirement marker", async () => {
    const s = await setup({ conv: { persistent: true } });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectClosed(await s.read());
  });

  test("a codecast flow run it started (its own station sessions) does not hold it: it comes back when the run reports", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const run = await ctx.db.insert("workflow_runs", { user_id: s.ids.user, workflow_name: "change", status: "running", node_statuses: [], created_at: 1, updated_at: 1 } as any);
      await ctx.db.patch(s.ids.conv, { workflow_run_id: run } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectClosed(await s.read());
  });
});

describe("the server sets aside what the client closed while it is in flight", () => {
  test("a session mid-turn is stashed, and no teardown is queued", async () => {
    const s = await setup({ agent: "working", conv: { updated_at: Date.now() } });
    await s.send("closeSessions", [[String(s.ids.conv)]]);
    expectAside(await s.read());
  });

  test("a session with a queued message is stashed", async () => {
    const s = await setup({ queued: true });
    await s.send("closeSession", [String(s.ids.conv)]);
    const r = await s.read();
    expectAside(r);
    expect(r.queued.status).toBe("pending");
  });

  test("an armed /loop (a wakeup inside the agent process) is stashed", async () => {
    const now = Date.now();
    const s = await setup({ conv: { loop_state: { status: "armed", wakeup_at: now + 600_000, armed_at: now, event_at: now } } });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("a running Workflow-tool run (inside the host process) is stashed", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const run = await ctx.db.insert("workflow_runs", { user_id: s.ids.user, run_kind: "workflow", external_run_id: "wf1", workflow_name: "audit", status: "running", node_statuses: [], created_at: 1, updated_at: 1 } as any);
      await ctx.db.patch(s.ids.conv, { workflow_run_id: run } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("a turn blocked on an AskUserQuestion poll is stashed", async () => {
    const s = await setup({ agent: "idle", newest: { tool_calls: [{ id: "q1", name: "AskUserQuestion", input: "{}" }] } });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("a lead whose subagent is mid-turn is stashed, and nothing in its group is stopped", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const now = Date.now();
      const child = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: now, updated_at: now, status: "active", session_id: "s-sub", message_count: 3, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
      await ctx.db.insert("managed_sessions", { session_id: "s-sub", conversation_id: child, user_id: s.ids.user, pid: 2, started_at: now, last_heartbeat: now, agent_status: "working", agent_status_updated_at: now } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });
});

describe("close carries through the deferred paths", () => {
  test("a close of more rows than one transaction applies keeps every row's trigger after the deferred batch", async () => {
    const s = await setup();
    const rows = await s.t.run(async (ctx) => {
      const out: any[] = [];
      for (let i = 0; i < 30; i++) {
        const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: `s-${i}`, message_count: 4 } as any);
        await ctx.db.insert("agent_tasks", { user_id: s.ids.user, title: `t${i}`, prompt: "p", schedule_type: "once", mode: "apply", status: "scheduled", retry_count: 0, run_count: 0, created_at: 1, run_at: Date.now() + 3_600_000, originating_conversation_id: c } as any);
        out.push(c);
      }
      return out;
    });
    const now = Date.now();
    await s.send("closeSessions", [rows.map(String)], Object.fromEntries(rows.map((c) => [String(c), { inbox_dismissed_at: now }])));
    // Let the deferred batches scheduled at 0 run (each may schedule the next).
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await s.t.finishInProgressScheduledFunctions();
    }
    const after = await s.t.run(async (ctx) => Promise.all(rows.map(async (c) => ({
      conv: (await ctx.db.get(c)) as any,
      task: (await ctx.db.query("agent_tasks").collect()).find((t: any) => String(t.originating_conversation_id) === String(c)) as any,
    }))));
    for (const { conv, task } of after) {
      expect(conv.inbox_dismissed_at).toBeGreaterThan(0);
      expect(conv.inbox_killed_at).toBeUndefined();
      expect(task.status).toBe("scheduled");
    }
  });

  test("the cascade's scheduled continuation keeps a closed lead's children's triggers", async () => {
    const s = await setup();
    const now = Date.now();
    const children = await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.conv, { inbox_dismissed_at: now } as any);
      const out: any[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: `s-c${i}`, message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
        await ctx.db.insert("agent_tasks", { user_id: s.ids.user, title: `c${i}`, prompt: "p", schedule_type: "once", mode: "apply", status: "scheduled", retry_count: 0, run_count: 0, created_at: 1, run_at: now + 3_600_000, originating_conversation_id: c } as any);
        out.push(c);
      }
      return out;
    });
    await s.t.mutation(internal.cleanup.continueCascadeHide, { lead_id: s.ids.conv, field: "inbox_dismissed_at", stamp: now, child_ids: children.map(String), force_kill: true, close: true, cause: "web:closeSession" });
    const tasks = await s.t.run(async (ctx) => (await ctx.db.query("agent_tasks").collect()).filter((t: any) => children.some((c) => String(c) === String(t.originating_conversation_id))));
    expect(tasks.map((t: any) => t.status)).toEqual(["scheduled", "scheduled", "scheduled"]);
    const rows = await s.t.run(async (ctx) => Promise.all(children.map((c) => ctx.db.get(c))));
    for (const r of rows as any[]) {
      expect(r.inbox_dismissed_at).toBe(now);
      expect(r.inbox_killed_at).toBeUndefined();
    }
  });
});

describe("a closed session is not retired", () => {
  test("a message reaching it brings it back", async () => {
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

  test("another session's `cast send` (wake: false) is accepted, queues, and revives it", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: "s-from", short_id: "jx7from", title: "Sender", message_count: 2 } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    const out = await s.t.run(async (ctx) => performSessionSend(ctx, s.ids.user, { to: "jx7clos", from: "jx7from", body: "status?", wake: false }));
    expect(out.message_id).not.toBeNull();
    const r = await s.read();
    expect(r.conv.inbox_dismissed_at).toBeUndefined();
    expect(r.conv.status).toBe("active");
    // The message kept from before the close is still queued, now with a live row to deliver into.
    expect(r.queued.status).toBe("pending");
    const sent = await s.t.run(async (ctx) => ctx.db.get(out.message_id!));
    expect((sent as any).status).toBe("pending");
  });
});

describe("killSession is still retirement", () => {
  test("a kill cancels the armed trigger and the queued message and stamps the retirement marker", async () => {
    const s = await setup();
    await s.send("killSession", [String(s.ids.conv)]);
    const { conv, task, queued, kills } = await s.read();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(conv.status).toBe("completed");
    expect(kills.length).toBe(1);
    expect(task.status).not.toBe("scheduled");
    expect(task.canceled_on_kill_at).toBeGreaterThan(0);
    expect(queued.status).not.toBe("pending");
  });

  test("a kill of a role's own session is refused", async () => {
    const s = await setup({ role: true });
    await expect(s.send("killSession", [String(s.ids.conv)])).rejects.toThrow(/@infra's own session/);
  });
});
