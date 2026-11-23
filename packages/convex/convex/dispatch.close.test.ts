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
import { closeSetsAsideOnServer, nestedGroupOf } from "./lib/closeAside";
import { cascadeTakesDownRow, isClosedSession } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

type Setup = { role?: boolean; conv?: Record<string, unknown>; queued?: boolean; queuedRow?: boolean; agent?: string; newest?: Record<string, unknown> };

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
    const queued = o.queued || o.queuedRow
      ? await ctx.db.insert("pending_messages", { conversation_id: c, from_user_id: user, content: "one more thing", status: "pending", created_at: now, retry_count: 0 } as any)
      : null;
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
    queued: ids.queued ? ((await ctx.db.get(ids.queued)) as any) : null,
    kills: (await ctx.db.query("daemon_commands").collect()).filter((c: any) => c.command === "kill_session"),
  }));
  return { t, ids, as, send, read, kills };
}

// Closed: dismissed with the close marker, torn down keeping its worktree, and
// nothing that reads as retired.
function expectClosed(r: { conv: any; task: any; kills: any[] }) {
  expect(r.conv.inbox_dismissed_at).toBeGreaterThan(0);
  expect(r.conv.inbox_closed_at).toBe(r.conv.inbox_dismissed_at);
  expect(JSON.parse(r.kills[0]?.args ?? "{}").keep_workspace).toBe(true);
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
  test("an ordinary idle session is stopped and keeps its armed trigger", async () => {
    const s = await setup({ agent: "idle" });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectClosed(await s.read());
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

  test("a pending message row is a wake even when the row's flag says none: the session is stashed", async () => {
    const s = await setup({ queuedRow: true });
    await s.send("closeSession", [String(s.ids.conv)]);
    const r = await s.read();
    expectAside(r);
    expect(r.queued.status).toBe("pending");
  });

  test("a session parked on a usage limit (the reset continues it) is stashed", async () => {
    const s = await setup({ conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: Date.now() - 60_000 } });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("a busy child among more than fifty is found: the newest are read first", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: `s-old${i}`, message_count: 2, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
      }
      const busy = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: now, updated_at: now, status: "active", session_id: "s-busy", message_count: 3, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
      await ctx.db.insert("managed_sessions", { session_id: "s-busy", conversation_id: busy, user_id: s.ids.user, pid: 3, started_at: now, last_heartbeat: now, agent_status: "working", agent_status_updated_at: now } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("open background work (a run_in_background Bash its daemon still vouches for) is a wake: the session is stashed", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("managed_sessions", {
        session_id: "s-close", conversation_id: s.ids.conv, user_id: s.ids.user, pid: 1, started_at: now - 3_600_000, last_heartbeat: now,
        agent_status: "waiting", agent_status_updated_at: now - 600_000, open_tasks: [{ id: "b1", kind: "background", command: "bun run build" }], open_tasks_at: now - 30_000,
      } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("a lead whose child holds open background work is stashed, the child untouched", async () => {
    const s = await setup();
    const child = await s.t.run(async (ctx) => {
      const now = Date.now();
      const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: now, updated_at: now - 600_000, status: "active", session_id: "s-bgkid", message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant" } as any);
      await ctx.db.insert("managed_sessions", { session_id: "s-bgkid", conversation_id: c, user_id: s.ids.user, pid: 2, started_at: now, last_heartbeat: now, agent_status: "waiting", agent_status_updated_at: now - 600_000, open_tasks: [{ id: "m1", kind: "monitor", description: "watch CI" }], open_tasks_at: now - 10_000 } as any);
      return c;
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
    expect(((await s.t.run((ctx) => ctx.db.get(child))) as any).inbox_dismissed_at).toBeUndefined();
  });

  test("undoing a close the server set aside clears the stash it wrote", async () => {
    const s = await setup({ queuedRow: true });
    const t = Date.now();
    await s.send("closeSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: t, inbox_closed_at: t } });
    const aside = (await s.read()).conv;
    expect(aside.inbox_stashed_at).toBe(t);
    // The marker stays, inert (no dismissed stamp), as the cell the undo clears with.
    expect(aside.inbox_closed_at).toBe(t);
    // The web's undo of the close (store undo/policies/sessions.ts spellUnclose).
    await s.send("restoreSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_closed_at: null, inbox_stashed_at: null } });
    const back = (await s.read()).conv;
    expect(back.inbox_stashed_at).toBeUndefined();
    expect(back.inbox_dismissed_at).toBeUndefined();
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

describe("a lead is in flight when any member of its nested group is", () => {
  const now = Date.now();
  const facts: Record<string, { conv?: Record<string, unknown>; agent?: string; pending?: boolean; run?: boolean; newest?: boolean }> = {
    loop: { conv: { loop_state: { status: "armed", wakeup_at: now + 600_000, armed_at: now, event_at: now } } },
    limit: { conv: { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: now - 60_000 } },
    workflow: { run: true },
    queued: { pending: true },
    awaiting: { agent: "permission_blocked" },
    poll: { agent: "idle", newest: true },
  };
  for (const [name, f] of Object.entries(facts)) {
    test(`a child with ${name} keeps its lead aside, and the child is untouched`, async () => {
      const s = await setup();
      const child = await s.t.run(async (ctx) => {
        const t = Date.now();
        const c = await ctx.db.insert("conversations", {
          user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: "s-kid", message_count: 4,
          is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant", ...f.conv,
        } as any);
        if (f.agent) await ctx.db.insert("managed_sessions", { session_id: "s-kid", conversation_id: c, user_id: s.ids.user, pid: 9, started_at: t, last_heartbeat: t, agent_status: f.agent, agent_status_updated_at: t } as any);
        if (f.newest) await ctx.db.insert("messages", { conversation_id: c, role: "assistant", content: "", timestamp: t, tool_calls: [{ id: "q", name: "AskUserQuestion", input: "{}" }] } as any);
        if (f.pending) await ctx.db.insert("pending_messages", { conversation_id: c, from_user_id: s.ids.user, content: "later", status: "pending", created_at: t, retry_count: 0 } as any);
        if (f.run) {
          const run = await ctx.db.insert("workflow_runs", { user_id: s.ids.user, run_kind: "workflow", external_run_id: "wf-kid", workflow_name: "audit", status: "running", node_statuses: [], created_at: 1, updated_at: 1 } as any);
          await ctx.db.patch(c, { workflow_run_id: run } as any);
        }
        return c;
      });
      await s.send("closeSession", [String(s.ids.conv)]);
      expectAside(await s.read());
      const kid = (await s.t.run((ctx) => ctx.db.get(child))) as any;
      expect(kid.inbox_dismissed_at).toBeUndefined();
      expect(kid.inbox_closed_at).toBeUndefined();
    });
  }

  for (const order of ["lead first", "child first"] as const) {
    test(`a close of a lead and its busy child together sets both aside, ${order}`, async () => {
      const s = await setup();
      const child = await s.t.run(async (ctx) => {
        const t = Date.now();
        const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t, status: "active", session_id: "s-kid", message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
        await ctx.db.insert("managed_sessions", { session_id: "s-kid", conversation_id: c, user_id: s.ids.user, pid: 9, started_at: t, last_heartbeat: t, agent_status: "working", agent_status_updated_at: t } as any);
        return c;
      });
      const t = Date.now();
      const lead = [String(s.ids.conv), { inbox_dismissed_at: t, inbox_closed_at: t }] as const;
      const kid = [String(child), { inbox_dismissed_at: t, inbox_closed_at: t }] as const;
      const rows = order === "lead first" ? [lead, kid] : [kid, lead];
      await s.send("closeSessions", [rows.map(([id]) => id)], Object.fromEntries(rows));
      expectAside(await s.read());
      const k = (await s.t.run((ctx) => ctx.db.get(child))) as any;
      expect(k.inbox_dismissed_at).toBeUndefined();
      // Set aside by the server: its marker stays, inert without a dismissed stamp.
      expect(isClosedSession(k)).toBe(false);
      expect(k.inbox_stashed_at).toBeGreaterThan(0);
    });
  }

  test("a kill of a lead does not override a child the same gesture already decided", async () => {
    const s = await setup();
    const t = Date.now();
    const child = await s.t.run(async (ctx) => ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t, status: "active", session_id: "s-kid", message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv } as any));
    // The child's own stash lands first; the lead's kill cascade must leave it stashed.
    await s.send("killSessions", [[String(child), String(s.ids.conv)]], { [String(child)]: { inbox_stashed_at: t }, [s.ids.conv]: { inbox_dismissed_at: t } });
    const k = (await s.t.run((ctx) => ctx.db.get(child))) as any;
    expect(k.inbox_stashed_at).toBe(t);
    expect(k.inbox_dismissed_at).toBeUndefined();
  });
});

// A db that counts every read it serves: a get, or one query run (first,
// take, collect, unique, paginate), however it was built.
function countingDb(db: any) {
  const counter = { reads: 0 };
  const TERMINAL = new Set(["first", "take", "collect", "unique", "paginate"]);
  const wrapQuery = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args: any[]) => {
        const out = v.apply(target, args);
        if (TERMINAL.has(String(prop))) { counter.reads++; return out; }
        return out && typeof out === "object" && !(out instanceof Promise) ? wrapQuery(out) : out;
      };
    },
  });
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "get") return (...args: any[]) => { counter.reads++; return target.get(...args); };
      if (prop === "query") return (...args: any[]) => wrapQuery(target.query(...args));
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped, counter };
}

// What the web client sends for a close of the lead (store closeInDraft): a
// patch for the lead and for each nested child the shared cascade rule takes
// down, all with the one stamp.
async function clientClosePatches(s: Awaited<ReturnType<typeof setup>>): Promise<Record<string, Record<string, unknown>>> {
  const ts = Date.now();
  const kids = await s.t.run(async (ctx) => nestedGroupOf(ctx, await ctx.db.get(s.ids.conv)));
  const out: Record<string, Record<string, unknown>> = { [String(s.ids.conv)]: { inbox_dismissed_at: ts, inbox_closed_at: ts } };
  for (const k of kids) {
    if (cascadeTakesDownRow(k, "inbox_dismissed_at", { forceKill: true, close: true, queued: !!k.has_pending_messages })) out[String(k._id)] = { inbox_dismissed_at: ts, inbox_closed_at: ts };
  }
  return out;
}

describe("the aside check is cheap on a big finished group", () => {
  test("a lead with 300 finished subagents and one busy one: set aside, under 2 reads per finished child", async () => {
    const s = await setup();
    const now = Date.now();
    await s.t.run(async (ctx) => {
      const kid = (i: number, extra: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
        user_id: s.ids.user, agent_type: "claude_code", started_at: i, updated_at: i, status: "completed", session_id: `s-done${i}`,
        message_count: 9, is_subagent: true, parent_conversation_id: s.ids.conv, ...extra,
      } as any);
      // The scan reads newest first: 150 finished, then the busy one, then 150 older finished.
      for (let i = 0; i < 150; i++) await kid(i);
      const busy = await kid(150, { status: "active", session_id: "s-busy", updated_at: now });
      await ctx.db.insert("managed_sessions", { session_id: "s-busy", conversation_id: busy, user_id: s.ids.user, pid: 7, started_at: now, last_heartbeat: now, agent_status: "working", agent_status_updated_at: now } as any);
      for (let i = 151; i < 301; i++) await kid(i);
    });
    const counted = await s.t.run(async (ctx) => {
      const { db, counter } = countingDb(ctx.db);
      const verdict = await closeSetsAsideOnServer({ db }, await ctx.db.get(s.ids.conv), now, { forceKill: true });
      return { verdict, reads: counter.reads };
    });
    expect(counted.verdict).toBe("nested");
    // 150 finished children are scanned before the busy one, and none costs a
    // read: the lead's own facts, the group's two index reads, the busy child's.
    // (Reading every member's full facts took 606 reads here.)
    expect(counted.reads).toBeLessThan(2 * 150);
    expect(counted.reads).toBeLessThan(20);
    await s.send("closeSession", [String(s.ids.conv)]);
    expectAside(await s.read());
  });

  test("a lead with 100 finished and 100 already-closed subagents reads under 2 per child, and a second close tears none down again", async () => {
    const s = await setup();
    const closedIds = await s.t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < 200; i++) {
        const closed = i % 2 === 0;
        const id = await ctx.db.insert("conversations", {
          user_id: s.ids.user, agent_type: "claude_code", started_at: i, updated_at: i, session_id: `s-m${i}`, message_count: 9,
          is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant",
          ...(closed ? { status: "active", inbox_dismissed_at: 5, inbox_closed_at: 5 } : { status: "completed" }),
        } as any);
        if (closed) out.push(String(id));
      }
      return out;
    });
    const counted = await s.t.run(async (ctx) => {
      const { db, counter } = countingDb(ctx.db);
      const verdict = await closeSetsAsideOnServer({ db }, await ctx.db.get(s.ids.conv), Date.now(), { forceKill: true });
      return { verdict, reads: counter.reads };
    });
    expect(counted.verdict).toBeNull();
    expect(counted.reads).toBeLessThan(2 * 200);
    expect(counted.reads).toBeLessThan(20);
    await s.send("closeSession", [String(s.ids.conv)], await clientClosePatches(s));
    // The already-closed children are not stopped again (the finished ones are
    // hidden with the lead, as any hide does).
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await s.t.finishInProgressScheduledFunctions();
    }
    const killed = (await s.kills()).map((c: any) => JSON.parse(c.args).conversation_id);
    expect(killed.filter((id: string) => closedIds.includes(id))).toEqual([]);
    expect(killed).toContain(String(s.ids.conv));
  });

  test("a killed child is not one the close takes down, so it costs nothing and holds nothing", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: i, updated_at: i, status: "active", session_id: `s-k${i}`, message_count: 3, is_subagent: true, parent_conversation_id: s.ids.conv, inbox_killed_at: 5, inbox_dismissed_at: 5 } as any);
      }
    });
    const counted = await s.t.run(async (ctx) => {
      const { db, counter } = countingDb(ctx.db);
      const verdict = await closeSetsAsideOnServer({ db }, await ctx.db.get(s.ids.conv), Date.now(), { forceKill: true });
      return { verdict, reads: counter.reads };
    });
    expect(counted.verdict).toBeNull();
    expect(counted.reads).toBeLessThan(10);
    const patches = await clientClosePatches(s);
    expect(Object.keys(patches)).toEqual([String(s.ids.conv)]);
    await s.send("closeSession", [String(s.ids.conv)], patches);
    const killed = (await s.kills()).map((c: any) => JSON.parse(c.args).conversation_id);
    expect(killed).toEqual([String(s.ids.conv)]);
  });
});

describe("a close is a close by its fields, on any rail", () => {
  test("a stub's re-key flush carrying both stamps closes the row without retiring it", async () => {
    const s = await setup();
    const t = Date.now();
    await s.as.mutation(api.dispatch.dispatch, { action: "flushResolvedSessionFields", args: [String(s.ids.conv), { inbox_dismissed_at: t, inbox_closed_at: t }] });
    expectClosed(await s.read());
  });

  test("the same flush with only the dismissed stamp is a plain dismissal: it retires", async () => {
    const s = await setup();
    await s.as.mutation(api.dispatch.dispatch, { action: "flushResolvedSessionFields", args: [String(s.ids.conv), { inbox_dismissed_at: Date.now() }] });
    const { conv, task } = await s.read();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(task.status).not.toBe("scheduled");
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
    const sent = await s.t.run(async (ctx) => ctx.db.get(out.message_id!));
    expect((sent as any).status).toBe("pending");
  });
});

describe("nothing retires a closed session after the fact", () => {
  test("the daemon's markSessionCompleted leaves it open, and a `cast send` with wake off is accepted and queued", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: "s-from", short_id: "jx7from", title: "Sender", message_count: 2 } as any);
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    await s.as.mutation(api.conversations.markSessionCompleted, { conversation_id: String(s.ids.conv) });
    expect((await s.read()).conv.status).toBe("active");
    const out = await s.t.run(async (ctx) => performSessionSend(ctx, s.ids.user, { to: "jx7clos", from: "jx7from", body: "status?", wake: false }));
    const sent = await s.t.run(async (ctx) => ctx.db.get(out.message_id!));
    expect((sent as any).status).toBe("pending");
    expect((await s.read()).conv.inbox_dismissed_at).toBeUndefined();
  });

  test("a killed session still completes", async () => {
    const s = await setup();
    await s.send("killSession", [String(s.ids.conv)]);
    await s.t.run(async (ctx) => ctx.db.patch(s.ids.conv, { status: "active" } as any));
    await s.as.mutation(api.conversations.markSessionCompleted, { conversation_id: String(s.ids.conv) });
    expect((await s.read()).conv.status).toBe("completed");
  });

  test("a closed worker frees its fleet slot and its lead hears nothing; a killed one reports", async () => {
    const run = async (action: "closeSession" | "killSession") => {
      const s = await setup();
      const worker = await s.t.run(async (ctx) => ctx.db.insert("conversations", {
        user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: "s-w", short_id: "jx7wrkr", message_count: 5,
        is_subagent: true, parent_conversation_id: s.ids.conv, subagent_slot: "running", merge_back_on_done: true, worktree_path: "/tmp/wt-w",
      } as any));
      await s.as.mutation(api.dispatch.dispatch, { action, args: [String(worker)], patches: { conversations: { [String(worker)]: { inbox_dismissed_at: Date.now() } } } });
      return s.t.run(async (ctx) => ({
        worker: (await ctx.db.get(worker)) as any,
        toLead: (await ctx.db.query("pending_messages").collect()).filter((m: any) => String(m.conversation_id) === String(s.ids.conv)),
      }));
    };
    const closed = await run("closeSession");
    expect(closed.worker.subagent_slot).toBeUndefined();
    expect(closed.worker.merge_back).toBeUndefined();
    expect(closed.toLead).toEqual([]);
    const killed = await run("killSession");
    expect(killed.worker.merge_back?.state).toBe("kept");
    expect(killed.toLead.length).toBe(1);
  });
});

describe("the daemon's lifecycle read", () => {
  const lifecycle = (s: Awaited<ReturnType<typeof setup>>) => s.as.query(api.conversations.getConversationLifecycle, { conversation_id: String(s.ids.conv) }) as Promise<any>;

  test("a closed session reads closed, so the daemon does not bring it back on its own", async () => {
    const s = await setup();
    await s.send("closeSession", [String(s.ids.conv)]);
    expect((await lifecycle(s)).closed).toBe(true);
  });

  test("a message waiting for it is a wake: it reads open whatever has_pending_messages says", async () => {
    const s = await setup();
    await s.send("closeSession", [String(s.ids.conv)]);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("pending_messages", { conversation_id: s.ids.conv, from_user_id: s.ids.user, content: "late", status: "pending", created_at: Date.now(), retry_count: 0 } as any);
    });
    expect((await lifecycle(s)).closed).toBe(false);
  });

  test("another dismissal is not a close: it stays resumable as before", async () => {
    const s = await setup({ conv: { inbox_dismissed_at: Date.now() - 1000 } });
    expect((await lifecycle(s)).closed).toBe(false);
  });

  test("an undone close is no longer closed (the stale marker is inert)", async () => {
    const s = await setup();
    await s.send("closeSession", [String(s.ids.conv)]);
    await s.send("restoreSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: null } });
    expect((await lifecycle(s)).closed).toBe(false);
  });
});

describe("listClosedSessions", () => {
  test("pages the closes newest-first and skips a close that was undone", async () => {
    const s = await setup();
    const [a, b] = await s.t.run(async (ctx) => {
      const mk = (sid: string) => ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: sid, message_count: 2 } as any);
      return [await mk("s-a"), await mk("s-b")];
    });
    await s.send("closeSession", [String(a)], { [String(a)]: { inbox_dismissed_at: Date.now() - 2000 } });
    await s.send("closeSession", [String(b)], { [String(b)]: { inbox_dismissed_at: Date.now() - 1000 } });
    await s.send("closeSession", [String(s.ids.conv)]);
    await s.send("restoreSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: null } });
    const page = await s.as.query(api.conversations.listClosedSessions, { paginationOpts: { numItems: 10, cursor: null } }) as any;
    expect(page.page.map((r: any) => String(r._id))).toEqual([String(b), String(a)]);
  });
});

describe("killSession is still retirement", () => {
  test("a kill cancels the armed trigger and the queued message and stamps the retirement marker", async () => {
    const s = await setup({ queuedRow: true });
    await s.send("killSession", [String(s.ids.conv)]);
    const { conv, task, queued, kills } = await s.read();
    expect(conv.inbox_killed_at).toBeGreaterThan(0);
    expect(conv.status).toBe("completed");
    expect(kills.length).toBe(1);
    expect(task.status).not.toBe("scheduled");
    expect(task.canceled_on_kill_at).toBeGreaterThan(0);
    expect(queued.status).not.toBe("pending");
    expect(JSON.parse(kills[0].args).keep_workspace).toBeUndefined();
  });

  test("a kill of a role's own session is refused", async () => {
    const s = await setup({ role: true });
    await expect(s.send("killSession", [String(s.ids.conv)])).rejects.toThrow(/@infra's own session/);
  });
});
