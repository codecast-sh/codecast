// A machine's report never undoes a close. After a close's teardown the daemon
// reports the agent "stopped" (Codex and SDK backends every time, tmux when it
// races). Every machine-originated reader (a stall check, a worker's report up,
// a role's route-up, a settle classifier, a stuck-send notice, a pane
// recovery, the daemon's fallback read) treats a closed session as it treats a
// killed one. A real wake (a send, a trigger, a run report) still revives it;
// dispatch.close.test.ts covers those.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { routeUpWaitingSession } from "./agentTasks";
import { notifyStuckSend } from "./pendingMessages";
import { planPaneRefusal } from "./lib/paneRefusal";

setDefaultTimeout(60_000);
const TOKEN = "close-reports-token";

async function setup(opts: { worker?: boolean; leadClosed?: boolean; workerClosed?: boolean; agentType?: string; lead?: Record<string, unknown> } = {}) {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { emailVerificationTime: 1, name: "R" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const closed = (on?: boolean) => (on ? { inbox_dismissed_at: now - 1000, inbox_closed_at: now - 1000 } : {});
    const lead = await ctx.db.insert("conversations", {
      user_id: user, agent_type: opts.agentType ?? "claude_code", started_at: now - 3_600_000, updated_at: now - 3_600_000, status: "active",
      session_id: "s-lead", short_id: "jx7lead", title: "lead", message_count: 12, last_message_role: "assistant", ...closed(opts.leadClosed), ...opts.lead,
    } as any);
    await ctx.db.insert("managed_sessions", { session_id: "s-lead", conversation_id: lead, user_id: user, pid: 1, started_at: now - 3_600_000, last_heartbeat: now, agent_status: "stopped", agent_status_updated_at: now } as any);
    await ctx.db.insert("messages", { conversation_id: lead, role: "assistant", content: "done", timestamp: now - 3_600_000 } as any);
    let worker: any = null;
    if (opts.worker) {
      worker = await ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", started_at: now - 3_600_000, updated_at: now - 3_000_000, status: "active", session_id: "s-w", short_id: "jx7wrkr",
        title: "worker", message_count: 8, last_message_role: "assistant", parent_conversation_id: lead, is_subagent: true, ...closed(opts.workerClosed),
      } as any);
      await ctx.db.insert("managed_sessions", { session_id: "s-w", conversation_id: worker, user_id: user, pid: 2, started_at: now - 3_600_000, last_heartbeat: now, agent_status: "stopped", agent_status_updated_at: now } as any);
      await ctx.db.insert("messages", { conversation_id: worker, role: "assistant", content: "working", timestamp: now - 3_000_000 } as any);
    }
    return { user, lead, worker };
  });
  const statusTs = (id: any) => t.run(async (ctx) => ((await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", id)).first()) as any).agent_status_updated_at);
  const row = (id: any) => t.run(async (ctx) => (await ctx.db.get(id)) as any);
  const toConv = (id: any) => t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()).filter((m: any) => String(m.conversation_id) === String(id)));
  return { t, ids, statusTs, row, toConv };
}

describe("a stopped report after a close", () => {
  for (const agentType of ["codex", "claude_code"]) {
    test(`a closed ${agentType} session that reports stopped stays closed`, async () => {
      const s = await setup({ leadClosed: true, agentType });
      const out = await s.t.mutation(internal.notifications.checkNeedsInput, { conversation_id: s.ids.lead, status_ts: await s.statusTs(s.ids.lead) });
      expect(out).toMatchObject({ notified: false, reason: "closed" });
      const lead = await s.row(s.ids.lead);
      expect(lead.inbox_dismissed_at).toBeGreaterThan(0);
      expect(lead.inbox_closed_at).toBe(lead.inbox_dismissed_at);
    });
  }

  test("a closed worker's stopped tells its lead nothing", async () => {
    for (const leadClosed of [false, true]) {
      const s = await setup({ worker: true, workerClosed: true, leadClosed });
      const out = await s.t.mutation(internal.workerSettle.tellParent, { conversation_id: s.ids.worker, status_ts: await s.statusTs(s.ids.worker) });
      expect(out.told).toBe(0);
      expect(await s.toConv(s.ids.lead)).toEqual([]);
    }
  });

  test("a closed lead is not woken by a worker's stopped", async () => {
    const s = await setup({ worker: true, leadClosed: true });
    const out = await s.t.mutation(internal.workerSettle.tellParent, { conversation_id: s.ids.worker, status_ts: await s.statusTs(s.ids.worker) });
    expect(out).toMatchObject({ told: 0, reason: "no_parent" });
    expect(await s.toConv(s.ids.lead)).toEqual([]);
  });

  test("an open lead still hears about an open worker that stopped", async () => {
    const s = await setup({ worker: true });
    const out = await s.t.mutation(internal.workerSettle.tellParent, { conversation_id: s.ids.worker, status_ts: await s.statusTs(s.ids.worker) });
    expect(out.told).toBe(1);
  });

  test("a role's closed hand is not routed up to its role", async () => {
    const s = await setup({ leadClosed: true });
    const said = await s.t.run(async (ctx) => routeUpWaitingSession(ctx as any, (await ctx.db.get(s.ids.lead)) as any, { why: "stopped", since: Date.now(), stuck: true }));
    expect(said).toBe("nobody");
  });

  test("a closed session's settle is not classified", async () => {
    const s = await setup({ leadClosed: true });
    expect(await s.t.mutation(internal.idleSummary.classifySettle, { conversation_id: s.ids.lead })).toMatchObject({ scheduled: false, reason: "closed" });
  });
});

describe("other machine readers", () => {
  test("a stuck send does not revive the closed session that sent it", async () => {
    const s = await setup({ worker: true, leadClosed: true });
    await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("pending_messages", { conversation_id: s.ids.worker, from_user_id: s.ids.user, from_conversation_id: s.ids.lead, content: "hi", status: "pending", created_at: Date.now(), retry_count: 0 } as any);
      await notifyStuckSend(ctx, await ctx.db.get(id), "refused");
    });
    expect(await s.toConv(s.ids.lead)).toEqual([]);
    expect((await s.row(s.ids.lead)).inbox_dismissed_at).toBeGreaterThan(0);
  });

  test("a closed role seat whose pane refuses input is not restarted", () => {
    const closed = { standing_role_id: "r1", inbox_dismissed_at: 5, inbox_closed_at: 5 };
    expect(planPaneRefusal(closed, Date.now())).toEqual({ kind: "give_up", markError: false });
    expect(planPaneRefusal({ standing_role_id: "r1" }, Date.now())).toEqual({ kind: "recover" });
  });

  test("the daemon's fallback and lifecycle reads both carry the close", async () => {
    const s = await setup({ leadClosed: true });
    const fallback = await s.t.query(api.devices.resolveConversationBySession, { api_token: TOKEN, session_id: "s-lead" }) as any;
    expect(fallback.closed).toBe(true);
    const lifecycle = await s.t.query(api.conversations.getConversationLifecycle, { api_token: TOKEN, conversation_id: String(s.ids.lead) }) as any;
    expect(lifecycle.inbox_closed_at).toBe(lifecycle.inbox_dismissed_at);
    expect(lifecycle.closed).toBe(true);
  });
});

describe("a worker waiting in its fleet's queue is a wake", () => {
  const queued = { subagent_slot: "queued", subagent_slot_at: Date.now() - 60_000, subagent_queued_start: { agentType: "claude_code", sessionId: "s-q", createdAt: 1 } };
  async function withQueued() {
    const s = await setup();
    const worker = await s.t.run(async (ctx) => ctx.db.insert("conversations", {
      user_id: s.ids.user, agent_type: "claude_code", started_at: Date.now(), updated_at: Date.now() - 60_000, status: "active", session_id: "s-q",
      message_count: 0, parent_conversation_id: s.ids.lead, is_subagent: true, ...queued,
    } as any));
    const as = s.t.withIdentity({ subject: `${s.ids.user}|test` });
    return { ...s, worker, as };
  }

  test("closing the queued worker sets it aside and keeps its queued start", async () => {
    const s = await withQueued();
    const ts = Date.now();
    await s.as.mutation(api.dispatch.dispatch, { action: "closeSession", args: [String(s.worker)], patches: { conversations: { [String(s.worker)]: { inbox_dismissed_at: ts, inbox_closed_at: ts } } } });
    const w = await s.row(s.worker);
    expect(w.inbox_dismissed_at).toBeUndefined();
    expect(w.inbox_stashed_at).toBe(ts);
    expect(w.subagent_slot).toBe("queued");
    expect(w.subagent_queued_start).toBeDefined();
  });

  test("closing its lead (and the worker, as the client sends) sets both aside and keeps the queued start", async () => {
    const s = await withQueued();
    const ts = Date.now();
    await s.as.mutation(api.dispatch.dispatch, { action: "closeSession", args: [String(s.ids.lead)], patches: { conversations: {
      [String(s.ids.lead)]: { inbox_dismissed_at: ts, inbox_closed_at: ts },
      [String(s.worker)]: { inbox_dismissed_at: ts, inbox_closed_at: ts },
    } } });
    const lead = await s.row(s.ids.lead);
    expect(lead.inbox_dismissed_at).toBeUndefined();
    expect(lead.inbox_stashed_at).toBe(ts);
    const w = await s.row(s.worker);
    expect(w.subagent_slot).toBe("queued");
    expect(w.subagent_queued_start).toBeDefined();
    expect(w.inbox_dismissed_at).toBeUndefined();
  });
});
