// Shared fixtures for the Close suites (dispatch.close.test.ts,
// dispatch.closeAdoption.test.ts): a user with one session and its armed
// trigger, the dispatch rail as the web calls it, and a read-counting db.
import { expect } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

export type Setup = {
  role?: boolean; conv?: Record<string, unknown>; queued?: boolean; queuedRow?: boolean; agent?: string; newest?: Record<string, unknown>;
  /** Writes the queued message `queued`/`queuedRow` ask for. A test file
   *  passes it: only pendingMessageWrites.ts inserts pending_messages in
   *  convex code (functions.guard.test.ts). */
  queueRow?: (ctx: any, conv: any, user: any, now: number) => Promise<any>;
};

export async function setup(o: Setup = {}) {
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
    const queued = (o.queued || o.queuedRow) && o.queueRow ? await o.queueRow(ctx, c, user, now) : null;
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
export function expectClosed(r: { conv: any; task: any; kills: any[] }) {
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
export function expectAside(r: { conv: any; kills: any[] }) {
  expect(r.conv.inbox_stashed_at).toBeGreaterThan(0);
  expect(r.conv.inbox_dismissed_at).toBeUndefined();
  expect(r.conv.inbox_killed_at).toBeUndefined();
  expect(r.kills.length).toBe(0);
}

// A db that counts every read it serves: a get, or one query run (first,
// take, collect, unique, paginate), however it was built.
export function countingDb(db: any) {
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
