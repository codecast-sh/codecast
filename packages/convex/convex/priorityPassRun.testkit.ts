// Shared fixtures for the priorities pass suites (priorityPassRun, priorityPassSweep,
// priorityPassEval tests): a stubbed model and a small seeded world. The
// model is a stubbed fetch; synthetic data only.
import { afterEach, beforeEach } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { budgetMonth } from "@codecast/shared/contracts/modelCall";

export const H = 3_600_000;
export const DAY = 24 * H;

const fn = internal as any;
/** The pass's functions, wherever they live. */
export const pass = {
  passInputs: fn.priorityPassInputs.passInputs,
  passGate: fn.priorityPassRun.passGate,
  runPass: fn.priorityPassRun.runPass,
  runNow: fn.priorityPassRun.runNow,
  applyPlan: fn.priorityPassRun.applyPlan,
  sweepCandidates: fn.priorityPassSweep.sweepCandidates,
  sweep: fn.priorityPassSweep.sweep,
  sweepTeam: fn.priorityPassSweep.sweepTeam,
  evalPass: fn.priorityPassEval.evalPass,
};

export type ModelStub = {
  /** Every prompt the model was asked, in order. */
  prompts: string[];
  reply: (prompt: string) => string;
  /** A status other than 200 answers as the model API would when overloaded. */
  status: number;
};

/** Every world a test made: its scheduled passes are cancelled when the test ends, so none runs into the next test's model. */
const worlds: Array<ReturnType<typeof convexTest>> = [];

/** Stubs the model for every test of the suite that calls it (at its top level). */
export function stubModel(): ModelStub {
  const m: ModelStub = { prompts: [], reply: () => "", status: 200 };
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    m.prompts = [];
    m.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    m.status = 200;
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const prompt = body.messages[0].content as string;
      m.prompts.push(prompt);
      if (m.status !== 200) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: m.status });
      return new Response(JSON.stringify({ content: [{ type: "text", text: m.reply(prompt) }], usage: { input_tokens: 1_000, output_tokens: 200 }, stop_reason: "end_turn" }));
    }) as unknown as typeof fetch;
  });
  afterEach(async () => {
    for (const t of worlds.splice(0)) {
      await t.run(async (ctx) => {
        for (const job of await ctx.db.system.query("_scheduled_functions").collect()) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      });
      await t.finishInProgressScheduledFunctions();
    }
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });
  return m;
}

/**
 * Ana and Ben in Acme (priorities on); Ana and Carl in Other (off). Ana runs
 * a team session in each team and a personal one; Ben runs one in Acme.
 */
export async function world() {
  const t = convexTest(schema, allModules);
  worlds.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const user = (name: string) => ctx.db.insert("users", { name } as any);
    const [ana, ben, carl] = [await user("Ana"), await user("Ben"), await user("Carl")];
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: 1, invite_code: "acme", features: { priorities: true } } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: 1, invite_code: "other" } as any);
    for (const [u, team] of [[ana, acme], [ben, acme], [ana, other], [carl, other]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    }
    for (const ws of [`team:${acme}`, `user:${ana}`]) {
      await ctx.db.insert("team_budgets", { workspace: ws, cap_usd: 100, month: budgetMonth(now), spent_usd: 0, held_usd: 0, by_purpose: { judge: 0, grouping: 0, call: 0 }, refused: 0, history: [], updated_at: 1 } as any);
    }
    const conv = (owner: Id<"users">, short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`, first_prompt: `make ${short_id} work`,
      started_at: now - 20 * DAY, updated_at: now - H, message_count: 3, status: "active", ...fields,
    } as any);
    const teamConv = await conv(ana, "jx7team", { team_id: acme, is_private: false, team_visibility: "full", thread_state: "Grader faults at 14%", thread_state_status: "working" });
    const oldConv = await conv(ana, "jx7old", { team_id: acme, is_private: false, team_visibility: "full" });
    const personalConv = await conv(ana, "jx7mine", { is_private: true });
    const benConv = await conv(ben, "jx7ben", { team_id: acme, is_private: false, team_visibility: "full" });
    const otherConv = await conv(ana, "jx7othr", { team_id: other, is_private: false, team_visibility: "full" });
    const carlConv = await conv(carl, "jx7carl", { team_id: other, is_private: false, team_visibility: "full" });
    return { ana, ben, carl, acme, other, teamConv, oldConv, personalConv, benConv, otherConv, carlConv };
  });
  const send = (user: Id<"users">, conversation: Id<"conversations">, timestamp: number, text: string) => t.run(async (ctx) => {
    const message = await ctx.db.insert("messages", { conversation_id: conversation, role: "user", content: text, timestamp } as any);
    await ctx.db.insert("user_sends", { user_id: user, conversation_id: conversation, message_id: message, timestamp, words: 3, text, clipped: false } as any);
  });
  const pin = (user: Id<"users">, conversation: Id<"conversations">, at: number, text: string) =>
    t.run((ctx) => ctx.db.insert("thread_state_events", { conversation_id: conversation, user_id: user, at, text, status: "working" }));
  const team = `team:${ids.acme}`;
  const runs = (workspace = team, user = ids.ana) => t.run((ctx) => ctx.db.query("priority_pass_runs").withIndex("by_user_workspace_started", (q) => q.eq("user_id", user).eq("workspace", workspace)).collect());
  /** The pair's newest run: index order (started_at, then creation), so two runs started in one millisecond still read in order. */
  const latestRun = async (workspace = team, user = ids.ana) => (await runs(workspace, user)).at(-1);
  const priorities = () => t.run((ctx) => ctx.db.query("priorities").collect());
  const conversation = (id: Id<"conversations">) => t.run((ctx) => ctx.db.get(id));
  return { t, now, ...ids, team, send, pin, runs, latestRun, priorities, conversation };
}

export const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Trusted evals",
  summary: "Grader faults falling",
  status: "active",
  serves: null,
  rank: 1,
  steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [{ kind: "session", id: "jx7team" }] }],
  sessions: [{ session: "jx7team", step: "s1" }],
  ...over,
});
