import { afterEach, beforeEach, describe, expect, jest, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { AFTER_CLOSE_CALL_MS } from "@codecast/shared/contracts/closeKind";
import * as teamBudget from "./lib/teamBudget";

// A contended budget row: while `contention` names a workspace, each reserve for it
// fails with Convex's write-conflict error until `contention.conflicts` runs out.
const contention = { workspace: "", conflicts: 0 };
const realBudget = { ...teamBudget };
mock.module("./lib/teamBudget", () => ({
  ...realBudget,
  takeBudget: async (ctx: any, workspace: string, ...rest: any[]) => {
    if (workspace === contention.workspace && contention.conflicts-- > 0) {
      throw new Error('Documents read from or written to the "team_budgets" table changed while this mutation was being run and on every subsequent retry.');
    }
    return (realBudget.takeBudget as any)(ctx, workspace, ...rest);
  },
}));

// closeAdvice.adviseAfterClose: the app's net after a Close or Kill.

setDefaultTimeout(60_000);

const NOW = Date.now();

describe("adviseAfterClose", () => {
  const T = NOW - 5_000; // when the gesture landed
  let prompts: string[] = [];
  let reply: () => Response;
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const answer = (text: string) => () => new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 1_000, output_tokens: 20 }, stop_reason: "end_turn" }), { status: 200 });
  beforeEach(() => {
    prompts = [];
    reply = answer("VERDICT: needs_you\nREASON: Check CI on the login fix yourself");
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async (url: any, init: any) => {
      if (!String(url).includes("api.anthropic.com")) throw new Error(`unexpected fetch ${url}`);
      const content = JSON.parse(init.body).messages[0].content;
      prompts.push(typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join(""));
      return reply();
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  /** One quiet team session whose last words promise to check back, with a
   *  standing trigger armed into it. */
  async function world(opts: {
    featureOff?: boolean; conv?: Record<string, unknown>; managed?: Record<string, unknown>; trigger?: Record<string, unknown>;
    ownersModel?: boolean; spawnedByLead?: boolean; outsider?: boolean; teammate?: boolean; haltedMidCall?: boolean; others?: number;
    /** The session's workspace keeps a model budget, so each call reserves and settles. */
    budget?: boolean;
  } = {}) {
    const t = convexTest(schema, allModules);
    const ids = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Riley" } as any);
      const outsider = await ctx.db.insert("users", { name: "Sam" } as any);
      const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1, features: { close_advice: !opts.featureOff, ...(opts.ownersModel ? { session_owners: true } : {}) } } as any);
      await ctx.db.insert("team_memberships", { team_id: team, user_id: user, role: "member", joined_at: 1 } as any);
      // A private session's calls are its owner's (workspaceForConversation).
      if (opts.budget) await teamBudget.setBudgetCap(ctx, `user:${user}`, undefined, 400, user, NOW);
      const teammate = await ctx.db.insert("users", { name: "Kai" } as any);
      await ctx.db.insert("team_memberships", { team_id: team, user_id: teammate, role: "member", joined_at: 1 } as any);
      const lead = opts.spawnedByLead ? await ctx.db.insert("conversations", {
        user_id: user, team_id: team, is_private: true, agent_type: "claude_code", status: "active", session_id: "s-lead",
        started_at: NOW - 9_000_000, updated_at: NOW - 60_000, message_count: 2, last_message_role: "assistant", title: "Lead",
      } as any) : undefined;
      const conv = await ctx.db.insert("conversations", {
        short_id: "jx7ci", user_id: user, team_id: team, is_private: true, agent_type: "claude_code", status: "active", session_id: "s-1",
        started_at: NOW - 7_200_000, updated_at: NOW - 3_600_000, message_count: 2, last_message_role: "assistant", title: "Fix login",
        armed_trigger_kind: "standing", ...(lead ? { spawned_by_conversation_id: lead } : {}),
        ...opts.conv,
      } as any);
      await ctx.db.insert("managed_sessions", {
        session_id: "s-1", conversation_id: conv, user_id: user, pid: 1, started_at: 1, agent_status: "idle", agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000,
        ...opts.managed,
      } as any);
      await ctx.db.insert("agent_tasks", {
        user_id: user, title: "Check CI", prompt: "check CI", schedule_type: "recurring", mode: "apply", status: "scheduled",
        retry_count: 0, run_count: 1, created_at: 1, originating_conversation_id: conv, ...opts.trigger,
      } as any);
      await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "fix the login", timestamp: NOW - 7_000_000, message_uuid: "m1" } as any);
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Pushed the fix. I'll check back on CI in an hour and report.", timestamp: NOW - 3_600_000, message_uuid: "m2" } as any);
      if (opts.haltedMidCall) {
        await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "", tool_calls: [{ id: "c1", name: "Bash", input: "gh run watch" }], timestamp: NOW - 3_599_000, message_uuid: "m3" } as any);
      }
      const others: string[] = [];
      for (let i = 0; i < (opts.others ?? 0); i++) {
        const other = await ctx.db.insert("conversations", {
          user_id: user, team_id: team, is_private: true, agent_type: "claude_code", status: "active", session_id: `s-o${i}`,
          started_at: NOW - 7_200_000, updated_at: NOW - 3_600_000, message_count: 1, last_message_role: "assistant", title: `Other ${i}`,
          ...opts.conv,
        } as any);
        await ctx.db.insert("messages", { conversation_id: other, role: "assistant", content: "Pushed the fix. I'll check back on CI in an hour and report.", timestamp: NOW - 3_600_000, message_uuid: `o${i}` } as any);
        others.push(String(other));
      }
      return { conv: String(conv), others, budgetWorkspace: `user:${user}`, caller: opts.outsider ? outsider : opts.teammate ? teammate : user };
    });
    const advise = (sessions: string[] = [ids.conv], gesture: "close" | "kill" = "kill") =>
      t.withIdentity({ subject: `${ids.caller}|session` }).action(api.closeAdvice.adviseAfterClose, { sessions, gesture });
    return { ids, advise, t };
  }

  /** What a Kill has written by the time advice reads the row: its stamps, the retirement, the stop, its trigger canceled. */
  const kill = {
    conv: { inbox_killed_at: T, inbox_dismissed_at: T, status: "completed", armed_trigger_kind: "none" },
    managed: { agent_status: "stopped", agent_status_updated_at: T + 2_000 },
    trigger: { status: "completed", canceled_on_kill_at: T },
  };
  const close = { conv: { inbox_dismissed_at: T, inbox_closed_at: T } };
  const factsOf = (prompt: string) => prompt.slice(prompt.indexOf("Facts:"));

  test("a Kill that canceled the trigger behind a promise to check back: needs_you, and the prompt says no wake is armed", async () => {
    const w = await world(kill);
    expect(await w.advise()).toEqual({ results: [{ session: w.ids.conv, verdict: "needs_you", reason: "Check CI on the login fix yourself" }] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Nothing the system can see will wake this session");
    expect(prompts[0]).toContain("Armed wakes: none (");
    expect(prompts[0]).toContain("Agent [FINAL MESSAGE]: Pushed the fix. I'll check back on CI in an hour and report.");
  });

  test("a Kill read before its write lands, trigger still armed: the prompt still says no wake is armed", async () => {
    const w = await world();
    expect((await w.advise()).results[0].verdict).toBe("needs_you");
    expect(prompts[0]).toContain("Nothing the system can see will wake this session");
    expect(prompts[0]).toContain("Armed wakes: none (");
    expect(prompts[0]).not.toContain("closing keeps one");
  });

  test("a Kill of a persistent anchor is dormancy: its trigger stays a verified wake", async () => {
    await (await world({ conv: { persistent: true } })).advise();
    expect(prompts[0]).toContain("Armed wakes: closing keeps one:");
  });

  test("a Close of the same session keeps its wake: the prompt says a verified wake stands", async () => {
    reply = answer("VERDICT: close\nREASON: Pushed the fix; its trigger checks CI");
    const w = await world(close);
    expect(await w.advise(undefined, "close")).toEqual({ results: [{ session: w.ids.conv, verdict: "close" }] });
    expect(prompts[0]).toContain("Closing keeps a wake the system verified");
    expect(prompts[0]).toContain("Armed wakes: closing keeps one: stops it,");
  });

  test("a Close of a session settle read as done since its last activity still asks the model: an older settle prompt may have missed the ask", async () => {
    const w = await world({ conv: { ...close.conv, settle_verdict: "done", settle_verdict_at: NOW - 3_500_000 } });
    expect((await w.advise(undefined, "close")).results[0].verdict).toBe("needs_you");
    expect(prompts).toHaveLength(1);
  });

  test("a Kill of a session settle read as done still asks the model: the kill cancels the wake settle counted on", async () => {
    const w = await world({ ...kill, conv: { ...kill.conv, settle_verdict: "done", settle_verdict_at: NOW - 3_500_000 } });
    expect((await w.advise()).results[0].verdict).toBe("needs_you");
    expect(prompts).toHaveLength(1);
  });

  test("a killed session's prompt does not present the kill as unfinished work", async () => {
    const w = await world({ ...kill, haltedMidCall: true });
    await w.advise();
    // The CLI's tail would say it halted mid-work; here that halt is the person's own stop.
    expect(prompts[0]).not.toContain("halted mid-work");
    for (const word of ["stopped", "killed", "completed", "dead", "dismissed"]) expect([word, factsOf(prompts[0]).toLowerCase().includes(word)]).toEqual([word, false]);
  });

  test("a closed session's prompt keeps the halted mid-work note: a Close sets it aside, it does not stop it", async () => {
    const w = await world({ ...close, haltedMidCall: true });
    await w.advise(undefined, "close");
    expect(prompts[0]).toContain("halted mid-work");
  });

  // A session the inbox files under Working: its process is live and its last turn is still running.
  const working = { conv: { ...close.conv, updated_at: NOW - 2_000 }, managed: { agent_status: "working", agent_status_updated_at: NOW - 2_000, last_heartbeat: NOW - 1_000 }, haltedMidCall: true };

  test("a Close of a session at work is close with no model call: it is set aside, not stopped, and has asked nothing", async () => {
    const w = await world(working);
    expect(await w.advise(undefined, "close")).toEqual({ results: [{ session: w.ids.conv, verdict: "close" }] });
    expect(prompts).toHaveLength(0);
  });

  test("a Kill of the same session still asks the model: the kill stops the work", async () => {
    const w = await world(working);
    expect((await w.advise(undefined, "kill")).results[0].verdict).toBe("needs_you");
    expect(prompts).toHaveLength(1);
  });

  test("a Close of a session whose turn ended while a background task runs still asks the model: its last words may ask", async () => {
    const w = await world({ ...close, managed: { agent_status: "waiting", open_tasks: [{ id: "b1", kind: "bash", description: "dev server" }], open_tasks_at: NOW - 30_000, last_heartbeat: NOW - 1_000 } });
    expect((await w.advise(undefined, "close")).results[0].verdict).toBe("needs_you");
    expect(prompts).toHaveLength(1);
  });

  test("a Close of a session waiting on a permission prompt still asks the model", async () => {
    const w = await world({ ...working, managed: { ...working.managed, agent_status: "permission_blocked" } });
    expect((await w.advise(undefined, "close")).results[0].verdict).toBe("needs_you");
    expect(prompts).toHaveLength(1);
  });

  test("the feature off: every session skips, and no model call", async () => {
    const w = await world({ featureOff: true });
    expect(await w.advise()).toEqual({ results: [{ session: w.ids.conv, verdict: "skip" }] });
    expect(prompts).toHaveLength(0);
  });

  test("a session the caller cannot read, or that does not exist, skips", async () => {
    const w = await world({ outsider: true });
    expect(await w.advise([w.ids.conv, "jx7nope"])).toEqual({ results: [{ session: w.ids.conv, verdict: "skip" }, { session: "jx7nope", verdict: "skip" }] });
    expect(prompts).toHaveLength(0);
  });

  test("a teammate's team-visible session skips: the caller can read it but it is not theirs to be asked about", async () => {
    const w = await world({ ...kill, conv: { ...kill.conv, is_private: false, team_visibility: "full" }, teammate: true });
    expect(await w.advise()).toEqual({ results: [{ session: w.ids.conv, verdict: "skip" }] });
    expect(prompts).toHaveLength(0);
    // The teammate really can read it: the skip is the owner rule, not the read rule.
    const read = await w.t.withIdentity({ subject: `${w.ids.caller}|session` }).action(api.closeAdvice.adviseClose, { session: w.ids.conv });
    expect("off" in read).toBe(false);
  });

  test("a session whose waits its agent owner answers skips: the owners model files it with its owner, not the person", async () => {
    const owned = await world({ ...kill, ownersModel: true, spawnedByLead: true });
    expect((await owned.advise()).results).toEqual([{ session: owned.ids.conv, verdict: "skip" }]);
    expect(prompts).toHaveLength(0);
    // The same session off the owners model is the person's.
    const off = await world({ ...kill, spawnedByLead: true });
    expect((await off.advise()).results[0].verdict).toBe("needs_you");
  });

  test("at most 20 sessions are advised; the rest skip", async () => {
    const w = await world({ ...kill, others: 21 });
    const { results } = await w.advise([w.ids.conv, ...w.ids.others]);
    expect(results.map((r) => r.verdict)).toEqual([...Array(20).fill("needs_you"), "skip", "skip"]);
    expect(prompts).toHaveLength(20);
  });

  test("a session sent twice is advised once", async () => {
    const w = await world(kill);
    const { results } = await w.advise([w.ids.conv, w.ids.conv]);
    expect(results).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  test("a slow call is close at AFTER_CLOSE_CALL_MS, and the gesture's other verdicts still come back in time", async () => {
    const w = await world({ ...kill, others: 1 });
    const fast = globalThis.fetch;
    // The gesture's own session stalls until its call is aborted; the other answers at once.
    globalThis.fetch = (async (url: any, init: any) => {
      if (!JSON.stringify(init.body).includes("Fix login")) return fast(url, init);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as any;
    jest.useFakeTimers();
    try {
      let out: { results: Array<{ session: string; verdict: string }> } | null = null;
      void w.advise([w.ids.conv, ...w.ids.others]).then((r) => { out = r; });
      // Real work between steps of the fake clock (the queries, the fast call): setImmediate is not faked.
      const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
      for (let ms = 0; ms < AFTER_CLOSE_CALL_MS - 100 && !out; ms += 100) {
        await settle();
        jest.advanceTimersByTime(100);
      }
      await settle();
      expect(out).toBe(null);
      for (let ms = 0; ms < 200 && !out; ms += 100) {
        jest.advanceTimersByTime(100);
        await settle();
      }
      expect(out!).toEqual({ results: [{ session: w.ids.conv, verdict: "close" }, { session: w.ids.others[0]!, verdict: "needs_you", reason: "Check CI on the login fix yourself" }] });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a model error or no verdict is close for that session: no warning, nothing thrown", async () => {
    const w = await world(kill);
    reply = () => new Response("overloaded", { status: 529 });
    expect(await w.advise()).toEqual({ results: [{ session: w.ids.conv, verdict: "close" }] });
    reply = answer("I think it is done");
    expect(await w.advise()).toEqual({ results: [{ session: w.ids.conv, verdict: "close" }] });
  });
  test("a session with no messages to read skips: no model call", async () => {
    const w = await world(kill);
    await w.t.run(async (ctx) => { for (const m of await ctx.db.query("messages").collect()) await ctx.db.delete(m._id); });
    expect(await w.advise()).toEqual({ results: [{ session: w.ids.conv, verdict: "skip" }] });
    expect(prompts).toEqual([]);
  });

  test("in a budgeted workspace, a reserve that keeps meeting a contended budget row is close at the one deadline from the action's start, and leaves no hold", async () => {
    const w = await world({ ...kill, budget: true });
    // Four write conflicts, ~7.5 s of backoff, before the reserve would land: past the deadline.
    Object.assign(contention, { workspace: w.ids.budgetWorkspace, conflicts: 4 });
    const random = spyOn(Math, "random").mockReturnValue(0.99);
    jest.useFakeTimers();
    try {
      let out: { results: Array<{ session: string; verdict: string }> } | null = null;
      void w.advise().then((r) => { out = r; });
      // convex-test loads modules and runs nested calls on macrotasks the fake clock does not drive.
      const pump = () => new Promise<void>((r) => { const { port1, port2 } = new MessageChannel(); port2.onmessage = () => r(); port1.postMessage(null); });
      for (let ms = 0; ms < 30_000 && !out; ms += 50) {
        for (let i = 0; i < 20; i++) await pump();
        jest.advanceTimersByTime(50);
      }
      expect(out!).toEqual({ results: [{ session: w.ids.conv, verdict: "close" }] });
    } finally {
      jest.useRealTimers();
      random.mockRestore();
      Object.assign(contention, { workspace: "", conflicts: 0 });
    }
    // The reserve never landed, so nothing was sent and nothing is held.
    expect(prompts).toEqual([]);
    const budget: any = await w.t.run((ctx) => ctx.db.query("team_budgets").withIndex("by_workspace", (q) => q.eq("workspace", w.ids.budgetWorkspace)).first());
    expect(budget.held_usd).toBe(0);
  });
});
