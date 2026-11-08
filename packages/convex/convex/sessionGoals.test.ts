// The session goal loop end to end under convex-test (task ct-87437): a goal
// set on a session sends its start, every backend's turn end (applyAgentStatus)
// schedules one judge, and the verdict continues, stops or surfaces the loop.
// The model is a stubbed fetch; the judge prompt itself is graded by
// packages/cli/scripts/goal-judge-eval.ts.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashToken } from "./apiTokens";
import { performGoalControl, performSetGoal } from "./sessionGoals";
import { formatGoalMessage, parseGoalMessage, GOAL_IDLE_LIMIT_MS } from "@codecast/shared/contracts/sessionGoal";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./managedSessions.ts": () => import("./managedSessions"),
  "./sessionGoals.ts": () => import("./sessionGoals"),
  "./conversations.ts": () => import("./conversations"),
  "./pendingMessages.ts": () => import("./pendingMessages"),
  "./dispatch.ts": () => import("./dispatch"),
  "./modelCalls.ts": () => import("./modelCalls"),
  "./vendorCoverage.ts": () => import("./vendorCoverage"),
};

const TOKEN = "goal-loop-test-token";
let reply = "";
let calls = 0;
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  calls = 0;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (url: any) => {
    if (!String(url).includes("api.anthropic.com")) throw new Error(`unexpected fetch ${url}`);
    calls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "end_turn" }), { status: 200 });
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ada" } as any);
    const stranger = await ctx.db.insert("users", { name: "Eve" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
    const conversation = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: "goal-session", short_id: "jx7goal", started_at: Date.now(), updated_at: Date.now(),
      message_count: 0, is_private: true, status: "active",
    } as any);
    await ctx.db.insert("managed_sessions", { session_id: "goal-session", conversation_id: conversation, user_id: user, pid: 1, started_at: Date.now(), last_heartbeat: Date.now(), agent_status: "working", agent_status_updated_at: Date.now() - 10_000 } as any);
    return { user, stranger, conversation };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const goalOf = (t: T, conversation: Id<"conversations">) =>
  t.run(async (ctx) => (await ctx.db.query("session_goals").withIndex("by_conversation", (q) => q.eq("conversation_id", conversation)).order("desc").first())!);
const goalMessages = (t: T, conversation: Id<"conversations">) =>
  t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()).filter((m) => m.conversation_id === conversation && parseGoalMessage(m.content)).map((m) => ({ ...parseGoalMessage(m.content)!, origin: m.origin })));
const judges = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("judgeTurn") && j.state.kind === "pending").map((j: any) => j.args[0]));

/** The daemon delivered the loop's queued messages. */
async function delivered(ctx: any, conversation: Id<"conversations">) {
  for (const m of await ctx.db.query("pending_messages").collect()) if (m.conversation_id === conversation) await ctx.db.patch(m._id, { status: "delivered" });
}

/** The session's synced transcript since the goal: the start, then a turn with a tool call and its result. */
async function turn(t: T, conversation: Id<"conversations">, result = "3 pass, 0 fail") {
  await t.run(async (ctx) => {
    const goal = (await ctx.db.query("session_goals").withIndex("by_conversation", (q) => q.eq("conversation_id", conversation)).order("desc").first())!;
    const at = Math.max(Date.now(), goal.created_at + 1);
    await delivered(ctx, conversation);
    await ctx.db.insert("messages", { conversation_id: conversation, role: "user", content: formatGoalMessage({ kind: "start", round: 0, of: 50, objective: goal.objective }), timestamp: at } as any);
    await ctx.db.insert("messages", { conversation_id: conversation, role: "assistant", content: "Running the tests.", tool_calls: [{ id: "t1", name: "Bash", input: "{\"command\":\"bun test\"}" }], timestamp: at + 1 } as any);
    await ctx.db.insert("messages", { conversation_id: conversation, role: "user", content: "", tool_results: [{ tool_use_id: "t1", content: result }], timestamp: at + 2 } as any);
  });
}

async function endTurn(t: T, conversation: Id<"conversations">, status = "idle", turn_completed_at?: number) {
  await t.mutation(api.managedSessions.updateAgentStatus, { conversation_id: conversation, api_token: TOKEN, agent_status: "working" as any, client_ts: Date.now() - 5 });
  return t.mutation(api.managedSessions.updateAgentStatus, { conversation_id: conversation, api_token: TOKEN, agent_status: status as any, client_ts: Date.now(), ...(turn_completed_at ? { turn_completed_at } : {}) });
}

describe("setting a goal", () => {
  test("sends the start as a machine message and arms the idle watch", async () => {
    const { t, user, conversation } = await setup();
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "  Make bun test pass  ", "ck-1"));
    const goal = await goalOf(t, conversation);
    expect(goal).toMatchObject({ status: "active", objective: "Make bun test pass", rounds: 0, max_rounds: 50, max_stalls: 3, idle_limit_ms: GOAL_IDLE_LIMIT_MS, client_key: "ck-1" });
    expect(await goalMessages(t, conversation)).toEqual([expect.objectContaining({ kind: "start", objective: "Make bun test pass", origin: "scheduler" })]);
    const idle = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("idleCheck")));
    expect(idle.length).toBe(1);
  });

  test("the same client key sets once; a new goal clears the old one", async () => {
    const { t, user, conversation } = await setup();
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "first", "ck-1"));
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "first", "ck-1"));
    expect((await goalMessages(t, conversation)).length).toBe(1);
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "second", "ck-2"));
    const rows = await t.run((ctx) => ctx.db.query("session_goals").collect());
    expect(rows.map((r) => [r.objective, r.status])).toEqual([["first", "cleared"], ["second", "active"]]);
  });

  test("someone who cannot send to the session cannot set its goal", async () => {
    const { t, stranger, conversation } = await setup();
    await expect(t.run((ctx) => performSetGoal(ctx as any, stranger, conversation, "take over", "ck-x"))).rejects.toThrow(/cannot send/);
  });

  test("the web dispatch returns a refusal instead of throwing", async () => {
    const { t, stranger, conversation } = await setup();
    const out = await t.withIdentity({ subject: stranger }).mutation(api.dispatch.dispatch, { action: "setSessionGoal", args: [conversation, "x", "ck-y"] });
    expect(out).toMatchObject({ ok: false, refused: expect.stringMatching(/cannot send/) });
  });
});

describe("a turn end", () => {
  test("schedules one judge per turn end, from the status write every backend makes", async () => {
    const { t, user, conversation } = await setup();
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "Make bun test pass", "ck-1"));
    await endTurn(t, conversation, "idle", 1_000);
    // The same turn end reported again (a heartbeat re-assert, a duplicate hook) is not judged twice.
    await t.mutation(api.managedSessions.updateAgentStatus, { conversation_id: conversation, api_token: TOKEN, agent_status: "idle", client_ts: Date.now(), turn_completed_at: 1_000 });
    expect(await judges(t)).toEqual([{ goal_id: (await goalOf(t, conversation))._id, turn_key: 1_000, attempt: 0 }]);
  });

  test("no goal, a paused goal or open background work schedule nothing", async () => {
    const { t, user, conversation } = await setup();
    await endTurn(t, conversation);
    expect(await judges(t)).toEqual([]);
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "x", "ck-1"));
    await endTurn(t, conversation, "waiting");
    expect(await judges(t)).toEqual([]);
    await t.run((ctx) => performGoalControl(ctx as any, user, conversation, "pause"));
    await endTurn(t, conversation);
    expect(await judges(t)).toEqual([]);
  });
});

describe("the verdict", () => {
  async function judged(verdict: object, opts: { result?: string } = {}) {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "Make bun test pass", "ck-1"));
    await turn(s.t, s.conversation, opts.result);
    await endTurn(s.t, s.conversation, "idle", 2_000);
    const [args] = await judges(s.t);
    reply = JSON.stringify(verdict);
    const out = await s.t.action(internal.sessionGoals.judgeTurn, args);
    return { ...s, out, goal: await goalOf(s.t, s.conversation), conv: await s.t.run((ctx) => ctx.db.get(s.conversation)) };
  }

  test("continue delivers the next round with the judge's next step", async () => {
    const { t, conversation, goal, out } = await judged({ verdict: "continue", reason: "Two tests fail", next_step: "Fix parse()" }, { result: "2 pass, 2 fail" });
    expect(out).toEqual({ verdict: "continue" });
    expect(goal).toMatchObject({ status: "active", rounds: 1, stalls: 0, reason: "Two tests fail", next_step: "Fix parse()", verdict: "continue" });
    expect((await goalMessages(t, conversation)).map((m) => [m.kind, m.round, m.next_step])).toEqual([["start", 0, undefined], ["continue", 1, "Fix parse()"]]);
  });

  test("the judge reads the turn's tool results, and the prompt holds the objective", async () => {
    let body: any = null;
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "Make bun test pass", "ck-1"));
    await turn(s.t, s.conversation, "7 pass, 0 fail");
    await endTurn(s.t, s.conversation, "idle", 2_000);
    const [args] = await judges(s.t);
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"verdict":"done","reason":"7 pass"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }));
    }) as any;
    await s.t.action(internal.sessionGoals.judgeTurn, args);
    const prompt = JSON.stringify(body.messages);
    expect(prompt).toContain("Make bun test pass");
    expect(prompt).toContain("7 pass, 0 fail");
    expect(body.model).toBe("claude-haiku-5-5");
  });

  test("done stops the loop and pins the outcome on the session", async () => {
    const { goal, conv } = await judged({ verdict: "done", reason: "bun test shows 3 pass, 0 fail" });
    expect(goal).toMatchObject({ status: "done", reason: "bun test shows 3 pass, 0 fail" });
    expect(conv).toMatchObject({ thread_state: "Goal met: bun test shows 3 pass, 0 fail", thread_state_status: "done" });
  });

  test("blocked lands as needs input with what is needed", async () => {
    const { t, conversation, goal, conv } = await judged({ verdict: "blocked", reason: "Needs a Cloudflare API token" });
    expect(goal.status).toBe("blocked");
    expect(conv).toMatchObject({ thread_state: "Goal blocked: Needs a Cloudflare API token", thread_state_status: "blocked" });
    expect((await goalMessages(t, conversation)).length).toBe(1);
  });

  test("a judge with no usable answer pauses the goal and surfaces it", async () => {
    const { goal, conv } = await judged({ nonsense: true });
    expect(calls).toBe(2);
    expect(goal).toMatchObject({ status: "paused", reason: "The goal review gave no usable verdict" });
    expect(conv?.thread_state_status).toBe("blocked");
  });

  test("a judge waits for the turn's reply to sync", async () => {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "x", "ck-1"));
    await s.t.run(async (ctx) => {
      await delivered(ctx, s.conversation);
      await ctx.db.insert("messages", { conversation_id: s.conversation, role: "user", content: formatGoalMessage({ kind: "start", round: 0, of: 50, objective: "x" }), timestamp: Date.now() + 1 } as any);
    });
    await endTurn(s.t, s.conversation, "idle", 3_000);
    const [args] = await judges(s.t);
    expect(await s.t.action(internal.sessionGoals.judgeTurn, args)).toEqual({ skipped: "not_synced" });
    expect(calls).toBe(0);
    expect((await judges(s.t)).some((a: any) => a.attempt === 1)).toBe(true);
  });

  test("a turn that ended before the agent received the goal is not judged", async () => {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "x", "ck-1"));
    await s.t.run(async (ctx) => {
      await ctx.db.insert("messages", { conversation_id: s.conversation, role: "assistant", content: "Unrelated work finished.", timestamp: Date.now() + 1 } as any);
    });
    await endTurn(s.t, s.conversation, "idle", 5_000);
    const [args] = await judges(s.t);
    expect(await s.t.action(internal.sessionGoals.judgeTurn, args)).toEqual({ skipped: "not_started" });
    expect(calls).toBe(0);
  });

  test("a person's pause while the judge runs wins", async () => {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "x", "ck-1"));
    await turn(s.t, s.conversation);
    await endTurn(s.t, s.conversation, "idle", 4_000);
    const [args] = await judges(s.t);
    await s.t.run((ctx) => performGoalControl(ctx as any, s.user, s.conversation, "pause"));
    reply = '{"verdict":"continue","reason":"more","next_step":"go"}';
    expect(await s.t.action(internal.sessionGoals.judgeTurn, args)).toEqual({ skipped: "not_active" });
    expect((await goalOf(s.t, s.conversation)).status).toBe("paused");
  });

  test("a verdict for a turn before a pause and resume changes nothing", async () => {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "x", "ck-1"));
    await turn(s.t, s.conversation);
    await endTurn(s.t, s.conversation, "idle", 6_000);
    const [args] = await judges(s.t);
    await s.t.run((ctx) => performGoalControl(ctx as any, s.user, s.conversation, "pause"));
    await s.t.run((ctx) => performGoalControl(ctx as any, s.user, s.conversation, "resume"));
    reply = '{"verdict":"continue","reason":"more","next_step":"go"}';
    expect(await s.t.action(internal.sessionGoals.judgeTurn, args)).toEqual({ skipped: "superseded" });
    expect((await goalMessages(s.t, s.conversation)).map((m) => m.kind)).toEqual(["start", "resume"]);
  });

  test("a verdict that lands after a new turn began is dropped", async () => {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "x", "ck-1"));
    await turn(s.t, s.conversation);
    await endTurn(s.t, s.conversation, "idle", 7_000);
    const [args] = await judges(s.t);
    await s.t.mutation(api.managedSessions.updateAgentStatus, { conversation_id: s.conversation, api_token: TOKEN, agent_status: "working", client_ts: Date.now() + 10 });
    expect(await s.t.mutation(internal.sessionGoals.applyVerdict, { goal_id: args.goal_id, turn_key: args.turn_key, verdict: { verdict: "continue", reason: "more", next_step: "go" }, used_tools: true })).toEqual({ applied: false });
    expect((await goalOf(s.t, s.conversation)).rounds).toBe(0);
  });

  test("resuming a blocked goal takes down the blocked pin", async () => {
    const { t, user, conversation } = await judged({ verdict: "blocked", reason: "Needs a token" });
    await t.run((ctx) => performGoalControl(ctx as any, user, conversation, "resume"));
    const conv = await t.run((ctx) => ctx.db.get(conversation));
    expect(conv?.thread_state ?? null).toBeNull();
    expect((await goalOf(t, conversation)).status).toBe("active");
  });

  test("resume restarts a paused goal with a fresh budget and tells the agent", async () => {
    const s = await setup();
    await s.t.run((ctx) => performSetGoal(ctx as any, s.user, s.conversation, "x", "ck-1"));
    await s.t.run(async (ctx) => {
      const g = (await ctx.db.query("session_goals").first())!;
      await ctx.db.patch(g._id, { status: "paused", rounds: 50, stalls: 3, reason: "Reached the limit of 50 rounds" });
    });
    await s.t.run((ctx) => performGoalControl(ctx as any, s.user, s.conversation, "resume"));
    expect(await goalOf(s.t, s.conversation)).toMatchObject({ status: "active", rounds: 0, stalls: 0 });
    expect((await goalMessages(s.t, s.conversation)).map((m) => m.kind)).toEqual(["start", "resume"]);
  });
});

describe("the idle limit", () => {
  test("pauses a goal nothing moved, and waits out a session that is moving", async () => {
    const { t, user, conversation } = await setup();
    await t.run((ctx) => performSetGoal(ctx as any, user, conversation, "x", "ck-1"));
    const goal = await goalOf(t, conversation);
    // The session moved a minute ago: the check reschedules.
    expect(await t.mutation(internal.sessionGoals.idleCheck, { goal_id: goal._id })).toEqual({ rescheduled: true });
    await t.run(async (ctx) => {
      await ctx.db.patch(goal._id, { last_activity_at: Date.now() - GOAL_IDLE_LIMIT_MS - 1 });
      await ctx.db.patch(conversation, { updated_at: Date.now() - GOAL_IDLE_LIMIT_MS - 1 });
    });
    expect(await t.mutation(internal.sessionGoals.idleCheck, { goal_id: goal._id })).toEqual({ paused: true });
    expect(await goalOf(t, conversation)).toMatchObject({ status: "paused", reason: "Nothing happened for 30 minutes" });
    expect((await t.run((ctx) => ctx.db.get(conversation)))?.thread_state_status).toBe("blocked");
  });
});

describe("the CLI", () => {
  test("a session cannot start or resume its own goal, but can pause it", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.sessionGoals.cliSet, { api_token: TOKEN, session: "jx7goal", objective: "x", from_session: "goal-session" })).rejects.toThrow(/cannot start or resume its own goal/);
    await t.mutation(api.sessionGoals.cliSet, { api_token: TOKEN, session: "jx7goal", objective: "x" });
    expect(await t.mutation(api.sessionGoals.cliControl, { api_token: TOKEN, session: "jx7goal", op: "pause", from_session: "goal-session" })).toMatchObject({ goal: { status: "paused" } });
    await expect(t.mutation(api.sessionGoals.cliControl, { api_token: TOKEN, session: "jx7goal", op: "resume", from_session: "jx7goal" })).rejects.toThrow(/own goal/);
  });

  test("cast loop set, show, pause and clear by short id", async () => {
    const { t, conversation } = await setup();
    const set = await t.mutation(api.sessionGoals.cliSet, { api_token: TOKEN, session: "jx7goal", objective: "Ship it" });
    expect(set).toMatchObject({ short_id: "jx7goal", goal: { objective: "Ship it", status: "active" } });
    expect(await t.query(api.sessionGoals.cliShow, { api_token: TOKEN, session: "jx7goal" })).toMatchObject({ goal: { status: "active" } });
    expect(await t.mutation(api.sessionGoals.cliControl, { api_token: TOKEN, session: "jx7goal", op: "pause" })).toMatchObject({ goal: { status: "paused" } });
    expect(await t.mutation(api.sessionGoals.cliControl, { api_token: TOKEN, session: "jx7goal", op: "clear" })).toMatchObject({ goal: { status: "cleared" } });
    expect((await t.withIdentity({ subject: (await t.run((ctx) => ctx.db.get(conversation)))!.user_id }).query(api.sessionGoals.forConversation, { conversation_id: conversation }))[0].status).toBe("cleared");
  });
});
