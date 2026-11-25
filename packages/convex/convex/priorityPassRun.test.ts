// The priorities pass, run end to end against the tables (priorityPassRun.ts):
// what it reads stays inside one person's workspace and after its cursor, it
// skips where the feature is off, a failed reply leaves the cursor where it
// was, what it writes is that person's alone, the person's own rank and tiers
// survive the next pass, and the sweep runs only flagged pairs with new work.
// The model is a stubbed fetch; synthetic data only.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { budgetMonth } from "@codecast/shared/contracts/modelCall";
import type { MergePlan } from "./lib/priorityPass";
import { LATE_MARGIN_MS, PRIORITY_PASS_DAILY_USD } from "./priorityPassRun";

setDefaultTimeout(60_000);

const pass = (internal as any).priorityPassRun;
const H = 3_600_000;
const DAY = 24 * H;

let prompts: string[];
let replyText: (prompt: string) => string;
/** A status other than 200 answers as the model API would when overloaded. */
let replyStatus: number;
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  prompts = [];
  replyText = () => JSON.stringify({ priorities: [], unassigned: [] });
  replyStatus = 200;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content as string;
    prompts.push(prompt);
    if (replyStatus !== 200) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: replyStatus });
    return new Response(JSON.stringify({ content: [{ type: "text", text: replyText(prompt) }], usage: { input_tokens: 1_000, output_tokens: 200 }, stop_reason: "end_turn" }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

/**
 * Ana and Ben in Acme (priorities on); Ana and Carl in Other (off). Ana runs
 * a team session in each team and a personal one; Ben runs one in Acme.
 */
async function world() {
  const t = convexTest(schema, allModules);
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
  const priorities = () => t.run((ctx) => ctx.db.query("priorities").collect());
  const conversation = (id: Id<"conversations">) => t.run((ctx) => ctx.db.get(id));
  return { t, now, ...ids, team, send, pin, runs, priorities, conversation };
}

const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Trusted evals",
  summary: "Grader faults falling",
  status: "active",
  serves: null,
  rank: 1,
  steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [{ kind: "session", id: "jx7team" }] }],
  sessions: [{ session: "jx7team", step: "s1" }],
  ...over,
});

describe("inputs", () => {
  test("only the person's own sessions in this workspace, touched after the cursor, with their tasks, pull requests, pins and goals", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      // The last pass read up to two hours ago.
      await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
      await ctx.db.insert("tasks", { user_id: w.ana, team_id: w.acme, workspace: w.team, short_id: "ct-1", title: "Fix the grader", task_type: "task", priority: "medium", source: "human", status: "in_progress", created_from_conversation: w.teamConv, created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("tasks", { user_id: w.ana, workspace: `user:${w.ana}`, short_id: "ct-2", title: "Personal errand", task_type: "task", priority: "medium", source: "human", status: "open", created_from_conversation: w.teamConv, created_at: 1, updated_at: 1 } as any);
      const pr = await ctx.db.insert("pull_requests", { team_id: w.acme, github_pr_id: 1, repository: "acme/app", number: 7, title: "Grader", body: "", state: "merged", author_github_username: "ana", linked_session_ids: [w.teamConv], created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("pull_request_sessions", { pull_request_id: pr, conversation_id: w.teamConv, tier: "committed", pr_number: 7, team_id: w.acme });
      for (const [n, status] of [[1, "active"], [2, "completed"]] as const) {
        await ctx.db.insert("initiatives", { user_id: w.ana, team_id: w.acme, workspace: w.team, short_id: `in-${n}`, title: `Goal ${n}`, project_ids: [], status, health: "none" } as any);
      }
    });
    await w.send(w.ana, w.oldConv, w.now - 3 * H, "before the cursor");
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    await w.pin(w.ana, w.teamConv, w.now - 30 * 60_000, "Grader faults at 12%");
    await w.send(w.ana, w.personalConv, w.now - H, "personal work");
    await w.send(w.ben, w.benConv, w.now - H, "ben's work");
    await w.send(w.ana, w.otherConv, w.now - H, "other team's work");

    const { input, cursor_at, more } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(cursor_at).toBe(w.now - 2 * H);
    expect(more).toBe(false);
    expect(input).toMatchObject({ person: "Ana", workspace: "Acme", initiatives: [{ short_id: "in-1", title: "Goal 1" }], priorities: [] });
    expect(input.sessions).toHaveLength(1);
    expect(input.sessions[0]).toMatchObject({
      id: "jx7team",
      first_prompt: "make jx7team work",
      pin: { text: "Grader faults at 14%", status: "working" },
      last_active: w.now - 30 * 60_000,
      tasks: [{ short_id: "ct-1", title: "Fix the grader", status: "in_progress" }],
      prs: [{ ref: "acme/app#7", merged: true }],
      pin_events: [{ at: w.now - 30 * 60_000, text: "Grader faults at 12%" }],
      typed: [{ at: w.now - H, text: "get grader faults under ten percent" }],
    });

    const personal = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: `user:${w.ana}` });
    expect(personal.input.sessions.map((s: any) => s.id)).toEqual(["jx7mine"]);
    expect(personal.cursor_at).toBeLessThan(w.now - 13 * DAY);
  });
});

describe("runPass", () => {
  test("with the feature off it records a skipped run and asks no model", async () => {
    const w = await world();
    await w.send(w.ana, w.otherConv, w.now - H, "other team's work");
    const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: `team:${w.other}` });
    expect(r).toEqual({ status: "skipped", reason: "feature_off" });
    expect(prompts).toHaveLength(0);
    expect((await w.runs(`team:${w.other}`)).map((x: any) => x.status)).toEqual(["skipped"]);
    expect(await w.priorities()).toEqual([]);
  });

  test("a team workspace the person is not a member of records a skipped run and asks no model, forced or not", async () => {
    const w = await world();
    // Carl is in Other, not Acme; Acme has the feature on.
    await w.send(w.carl, w.carlConv, w.now - H, "carl's work");
    expect(await w.t.action(pass.runPass, { user_id: w.carl, workspace: w.team })).toEqual({ status: "skipped", reason: "feature_off" });
    expect(await w.t.action(pass.runNow, { user_id: w.carl, workspace: w.team })).toEqual({ status: "skipped", reason: "feature_off" });
    expect(prompts).toHaveLength(0);
    expect((await w.runs(w.team, w.carl)).map((x: any) => x.status)).toEqual(["skipped", "skipped"]);
    expect(await w.priorities()).toEqual([]);
  });

  test("with nothing touched it skips unless forced", async () => {
    const w = await world();
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(prompts).toHaveLength(0);
    expect((await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(prompts).toHaveLength(1);
  });

  test("an unreadable reply records an error and keeps the cursor, so the next pass reads the same work", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    for (const bad of ["I could not decide.", JSON.stringify({ groups: [] })]) {
      replyText = () => bad;
      const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
      expect(r.status).toBe("error");
    }
    const failed = await w.runs();
    expect(failed.map((x: any) => x.status)).toEqual(["error", "error"]);
    expect(failed.every((x: any) => x.cursor_at < w.now - 13 * DAY)).toBe(true);
    expect(await w.priorities()).toEqual([]);

    replyText = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(prompts.at(-1)).toContain("get grader faults under ten percent");
    const last = (await w.runs()).at(-1)!;
    expect(last).toMatchObject({ status: "ok", counts: { created: 1, mapped_sessions: 1 } });
    // Everything was read: the cursor moves to a few minutes ago, where late rows can still land.
    expect(last.cursor_at).toBeGreaterThan(w.now - LATE_MARGIN_MS - 60_000);
  });

  test("creates pri-N rows and maps the session; the person's rank and tier survive the next pass", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "get grader faults under ten percent");
    replyText = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");

    const [created] = await w.priorities();
    expect(created).toMatchObject({ short_id: "pri-1", user_id: w.ana, workspace: w.team, title: "Trusted evals", status: "active", rank: 1, rank_set_by: "pass" });
    expect(created.steps).toEqual([{ key: "s1", title: "Grader faults under 10%", tier: "critical", tier_set_by: "pass", refs: [{ kind: "session", id: "jx7team" }], done: false }]);
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: created._id, priority_step_key: "s1" });

    // The person ranks it third and moves its step to polish.
    await w.t.run((ctx) => ctx.db.patch(created._id, { rank: 3, rank_set_by: "person", steps: [{ ...created.steps[0], tier: "polish", tier_set_by: "person" }] }));
    // Stamped below the cursor but landing after the first pass: the overlap reads it.
    await w.send(w.ana, w.teamConv, w.now - 8 * 60_000, "grader faults at nine percent");
    replyText = (prompt) => {
      expect(prompt).toContain("pri-1");
      return JSON.stringify({ priorities: [proposal({ short_id: "pri-1", rank: 1, summary: "Under ten percent" })], unassigned: [] });
    };
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    const [after] = await w.priorities();
    expect(after).toMatchObject({ short_id: "pri-1", summary: "Under ten percent", rank: 3, rank_set_by: "person" });
    expect(after.steps[0]).toMatchObject({ key: "s1", tier: "polish", tier_set_by: "person" });
  });
});

describe("runPass, harder cases", () => {
  test("a workspace with no model budget still gets its pass, on codecast's own key", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (const b of await ctx.db.query("team_budgets").collect()) await ctx.db.delete(b._id);
    });
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    replyText = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(r).toMatchObject({ status: "ok", counts: { created: 1 } });
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(prompts).toHaveLength(1);
    // Nothing was charged to a budget: none was created or spent.
    expect(await w.t.run((ctx) => ctx.db.query("team_budgets").collect())).toEqual([]);
  });

  test("more sessions than one prompt holds are read oldest first in chained runs, and every one is read", async () => {
    const w = await world();
    const N = 70;
    const at = (i: number) => w.now - 10 * DAY + i * 60_000;
    const ids = await w.t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < N; i++) {
        const short_id = `jx7s${String(i).padStart(3, "0")}`;
        const conv = await ctx.db.insert("conversations", {
          user_id: w.ana, team_id: w.acme, is_private: false, team_visibility: "full", agent_type: "claude_code", session_id: short_id, short_id,
          title: `Chunk ${short_id}`, first_prompt: "p".repeat(1_500), idle_summary: "s".repeat(600), started_at: 1, updated_at: 1, message_count: 3, status: "active",
        } as any);
        // The last session types less, so its early ask fits its typed-text budget in the prompt.
        for (let j = 0; j < (i === N - 1 ? 5 : 7); j++) {
          const timestamp = at(i) - (7 - j) * 1_000;
          const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "x", timestamp } as any);
          await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: conv, message_id: message, timestamp, words: 100, text: `${short_id} ${"t".repeat(590)}`, clipped: false } as any);
        }
        if (i === N - 1) {
          const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "x", timestamp: at(0) - 30_000 } as any);
          await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: conv, message_id: message, timestamp: at(0) - 30_000, words: 3, text: "early ask of the last session", clipped: false } as any);
        }
        out.push(short_id);
      }
      return out;
    });
    const scheduledRuns = async () => (await w.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.name.includes("runPass"));

    let r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(r).toMatchObject({ status: "ok", chained: true });
    // The first chunk holds the sessions that started earliest: the last session's early ask is read there.
    expect(prompts[0]).toContain(`## Session ${ids[0]} `);
    expect(prompts[0]).toContain("early ask of the last session");
    expect(prompts[0]).not.toContain(`## Session ${ids[N - 2]} `);
    for (let guard = 0; r.chained && guard < 6; guard++) {
      const jobs = await scheduledRuns();
      const next = jobs[jobs.length - 1].args[0];
      expect(next.chain).toBe(guard + 1);
      r = await w.t.action(pass.runPass, next);
    }
    expect(r.status).toBe("ok");
    expect(r.chained).toBeUndefined();
    expect(prompts.length).toBeGreaterThan(1);
    for (const id of ids) expect(prompts.some((p) => p.includes(`## Session ${id} `))).toBe(true);
    const runs = await w.runs();
    expect(runs.every((x: any) => x.status === "ok")).toBe(true);
    expect(runs.at(-1)!.cursor_at).toBeGreaterThanOrEqual(at(N - 1) - 1_000);
    // The cursor moved forward chunk by chunk.
    for (let i = 1; i < runs.length; i++) expect(runs[i].cursor_at).toBeGreaterThan(runs[i - 1].cursor_at);
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "nothing_new" });
  });

  test("of two interleaved runs, the one that applies after the other finished writes nothing and keeps the newer cursor", async () => {
    const w = await world();
    const plan = (title: string): MergePlan => ({
      creates: [{ ref: "new-1", first_seen_at: 1, title, summary: "", status: "active", rank: 1, rank_set_by: "pass", serves: null, steps: [], last_active_at: 1, done_at: null, pass_at: 1 }],
      updates: [], merges: [], sessions: [{ session: "jx7team", priority: "new-1", step_key: null }], unmap: [], notes: [],
    });
    const apply = (title: string, started_at: number, from_cursor: number, cursor_at: number) =>
      w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at, from_cursor, cursor_at, model: "m", plan: plan(title) });

    // B starts, A starts and reads further, B finishes, then A tries to write.
    const bStarted = Date.now() - 1_000;
    const aStarted = Date.now() - 500;
    expect(await apply("B", bStarted, 50, 200)).toMatchObject({ created: 1 });
    expect(await apply("A", aStarted, 50, 400)).toBeNull();

    expect((await w.priorities()).map((p: any) => p.title)).toEqual(["B"]);
    const b = (await w.priorities())[0];
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(b._id);
    const runs = await w.runs();
    // A records where it started, so nothing past B's cursor is skipped; the cursor is B's.
    expect(runs.map((x: any) => [x.status, x.error ?? null, x.cursor_at])).toEqual([["ok", null, 200], ["skipped", "superseded", 50]]);
    expect((await w.t.query(pass.passGate, { user_id: w.ana, workspace: w.team })).cursor_at).toBe(200);

    // A run that starts after B finished applies as usual.
    expect(await apply("C", Date.now() + 1, 200, 300)).toMatchObject({ created: 1 });
  });
});

describe("what a pass may read, and how far", () => {
  test("a session filed under a team whose data may not go to the model vendor is never read, in either workspace", async () => {
    const w = await world();
    const clinicConv = await w.t.run(async (ctx) => {
      const clinic = await ctx.db.insert("teams", { name: "Clinic", invite_code: "clinic", created_at: 1, policy: { regulated_data: true } } as any);
      return ctx.db.insert("conversations", {
        user_id: w.ana, team_id: clinic, is_private: true, agent_type: "claude_code", session_id: "jx7clin", short_id: "jx7clin", title: "Patient intake",
        started_at: 1, updated_at: 1, message_count: 1, status: "active",
      } as any);
    });
    await w.send(w.ana, clinicConv, w.now - H, "patient notes");
    await w.send(w.ana, w.personalConv, w.now - H, "personal work");
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: `user:${w.ana}` });
    expect(input.sessions.map((s: any) => s.id)).toEqual(["jx7mine"]);
  });

  test("a message that lands late, below the cursor, is read by the next pass; one read already is not read again", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 8 * 60_000, "already read once");
    // Landed before the pass started, not in the same millisecond (which reads it again: a repeat, never a loss).
    await new Promise((r) => setTimeout(r, 5));
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(prompts[0]).toContain("already read once");
    // A client that was offline syncs a message stamped before the pass.
    await w.send(w.ana, w.teamConv, w.now - 7 * 60_000, "synced late");
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(prompts[1]).toContain("synced late");
    expect(prompts[1]).not.toContain("already read once");
  });

  test("a pair whose window is full of another workspace's activity is swept, and its pass moves the cursor past it", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const timestamp = w.now - 2 * H + i * 1_000;
        const message = await ctx.db.insert("messages", { conversation_id: w.teamConv, role: "user", content: "x", timestamp } as any);
        await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: w.teamConv, message_id: message, timestamp, words: 1, text: `team ${i}`, clipped: false } as any);
      }
    });
    const personal = `user:${w.ana}`;
    expect(await w.t.query(pass.sweepCandidates, {})).toContainEqual({ user_id: w.ana, workspace: personal });
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: personal })).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(prompts).toHaveLength(0);
    expect((await w.runs(personal)).at(-1)!.cursor_at).toBeGreaterThan(w.now - 2 * H + 299_000);
    expect(await w.t.query(pass.sweepCandidates, {})).not.toContainEqual({ user_id: w.ana, workspace: personal });
  });

  test("the third failure in a row on one cursor steps past what failed, and says so", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    replyText = () => "no JSON here";
    for (let i = 0; i < 3; i++) expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("error");
    const runs = await w.runs();
    expect(runs[0].cursor_at).toBe(runs[1].cursor_at);
    expect(runs[2].cursor_at).toBeGreaterThan(w.now - H);
    expect(runs[2].error).toContain("stepped past");
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(prompts).toHaveLength(3);
  });

  test("an overloaded model three times in a row loses no work: the cursor stays until a pass goes through", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "the work that must not be lost");
    replyStatus = 529;
    for (let i = 0; i < 3; i++) expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("error");
    const failed = await w.runs();
    expect(failed.map((x: any) => [x.status, x.repeats ?? false])).toEqual([["error", false], ["error", false], ["error", false]]);
    expect(new Set(failed.map((x: any) => x.cursor_at)).size).toBe(1);
    expect(failed.every((x: any) => !x.error.includes("stepped past"))).toBe(true);
    replyStatus = 200;
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(prompts.at(-1)).toContain("the work that must not be lost");
  });

  test("four runNow at once make one model call; the others are told a pass is running", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    const results = await Promise.all([0, 1, 2, 3].map(() => w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })));
    expect(prompts).toHaveLength(1);
    expect(results.filter((r: any) => r.status === "ok")).toHaveLength(1);
    expect(results.filter((r: any) => r.status === "skipped").map((r: any) => r.reason)).toEqual(Array(3).fill("A pass is already running here."));
    // One row, settled: no reservation is left running.
    expect((await w.runs()).map((x: any) => x.status)).toEqual(["ok"]);
  });

  test("a reservation older than its time to live is dead: the next run settles it as abandoned and goes ahead", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 20 * 60_000, finished_at: w.now - 20 * 60_000, status: "running", cursor_at: w.now - 2 * DAY, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect((await w.runs()).map((x: any) => [x.status, x.error ?? null])).toEqual([["error", "abandoned: the run stopped before it settled"], ["ok", null]]);
  });

  test("a pair that spent its daily ceiling skips without asking the model", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", cost_usd: PRIORITY_PASS_DAILY_USD, counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "Passes here spent today's $1.50; the next one can run tomorrow." });
    expect(await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "Passes here spent today's $1.50; the next one can run tomorrow." });
    expect(prompts).toHaveLength(0);
    expect((await w.runs()).at(-1)).toMatchObject({ status: "skipped", error: "daily ceiling" });
  });

  test("runNow runs once in ten minutes per pair and says when it can run again", async () => {
    const w = await world();
    expect((await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    const again = await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team });
    expect(again.status).toBe("skipped");
    expect(again.reason).toMatch(/^A pass ran here \d+ minutes? ago; run it again in 10 minutes\.$/);
    expect(prompts).toHaveLength(1);
    // Another person's pass is their own.
    expect((await w.t.action(pass.runNow, { user_id: w.ana, workspace: `user:${w.ana}` })).status).toBe("ok");
  });
});

describe("applyPlan", () => {
  const write = { title: "Mine", summary: "s", status: "active" as const, rank: 1, rank_set_by: "pass" as const, serves: null, steps: [], last_active_at: 1, done_at: null, pass_at: 1 };

  test("never maps a conversation of another person or another workspace, never touches another person's priority, and lets a rank set meanwhile stand", async () => {
    const w = await world();
    const bens = await w.t.run((ctx) => ctx.db.insert("priorities", { user_id: w.ben, workspace: w.team, short_id: "pri-50", title: "Ben's", summary: "", status: "active", rank: 1, rank_set_by: "pass", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 }));
    const ranked = await w.t.run((ctx) => ctx.db.insert("priorities", { user_id: w.ana, workspace: w.team, short_id: "pri-51", title: "Ranked", summary: "", status: "active", rank: 2, rank_set_by: "person", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 }));
    const plan: MergePlan = {
      creates: [{ ref: "new-1", first_seen_at: 1, ...write }],
      updates: [
        { short_id: "pri-50", patch: { title: "Taken over" } },
        { short_id: "pri-51", patch: { rank: 1, rank_set_by: "pass", title: "Ranked still" } },
      ],
      merges: [{ short_id: "pri-50", merged_into: "new-1" }],
      sessions: ["jx7team", "jx7ben", "jx7mine", "jx7othr"].map((session) => ({ session, priority: "new-1", step_key: null })),
      unmap: [],
      notes: [],
    };
    const counts = await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: 1, from_cursor: 1, cursor_at: 5, model: "m", plan });
    expect(counts).toEqual({ created: 1, updated: 1, merged: 0, mapped_sessions: 1 });

    const created = (await w.priorities()).find((p: any) => p.title === "Mine")!;
    expect(created.short_id).toMatch(/^pri-\d+$/);
    expect(created).not.toHaveProperty("serves");
    expect(created).not.toHaveProperty("done_at");
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(created._id);
    for (const other of [w.benConv, w.personalConv, w.otherConv]) expect((await w.conversation(other))?.priority_id).toBeUndefined();
    expect(await w.t.run((ctx) => ctx.db.get(bens))).toMatchObject({ title: "Ben's", status: "active" });
    expect(await w.t.run((ctx) => ctx.db.get(ranked))).toMatchObject({ title: "Ranked still", rank: 2, rank_set_by: "person" });
    expect((await w.runs()).at(-1)).toMatchObject({ status: "ok", cursor_at: 5 });
  });
});

describe("sweep", () => {
  test("fans out only pairs with the feature on and work since their cursor", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "team work");
    await w.send(w.ana, w.otherConv, w.now - H, "work in a team without the feature");
    await w.send(w.carl, w.carlConv, w.now - H, "carl's work");
    await w.pin(w.ben, w.benConv, w.now - 5 * H, "Ben's pin");
    // Ben's pin is older than his last pass.
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ben, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));

    expect(await w.t.query(pass.sweepCandidates, {})).toEqual([{ user_id: w.ana, workspace: w.team }]);
    expect(await w.t.action(pass.sweep, {})).toBe(1);
    const jobs = await w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("runPass")));
    expect(jobs.map((j: any) => j.args[0])).toEqual([{ user_id: w.ana, workspace: w.team }]);
  });
});

describe("evalPass", () => {
  test("runs from empty over the window and writes nothing: no priority, no mapping, no run row", async () => {
    const w = await world();
    // A priority the person already has is not part of a calibration pass.
    await w.t.run((ctx) => ctx.db.insert("priorities", { user_id: w.ana, workspace: w.team, short_id: "pri-60", title: "Already here", summary: "", status: "active", rank: 1, rank_set_by: "pass", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 }));
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "get grader faults under ten percent");
    await w.send(w.ana, w.oldConv, w.now - 30 * DAY, "before the window");
    replyText = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });

    const r = await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: w.now - 3 * DAY, window_end: w.now });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("(none yet)");
    expect(prompts[0]).not.toContain("before the window");
    expect(r.sessions_read).toEqual([{ id: "jx7team", title: "Session jx7team" }]);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(r.resume).toBeUndefined();
    expect(r.priorities).toHaveLength(1);
    expect(r.priorities[0]).toMatchObject({ short_id: "pri-1", title: "Trusted evals", status: "active", sessions: [{ id: "jx7team", step_key: "s1" }] });

    expect((await w.priorities()).map((p: any) => p.short_id)).toEqual(["pri-60"]);
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    expect(await w.runs()).toEqual([]);
  });

  test("chunks chain oldest first: each chunk's priorities are the next chunk's existing ones", async () => {
    const w = await world();
    await w.send(w.ana, w.oldConv, w.now - 2 * DAY, "start the grader work");
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    replyText = () => prompts.length === 1
      ? JSON.stringify({ priorities: [proposal({ steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "s1" }] })], unassigned: [] })
      : JSON.stringify({ priorities: [proposal({ short_id: "pri-1", steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], sessions: [{ session: "jx7team", step: "s1" }] })], unassigned: [] });

    const r = await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: w.now - 3 * DAY, window_end: w.now, chunk: 1 });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("start the grader work");
    expect(prompts[0]).not.toContain("get grader faults under ten percent");
    expect(prompts[1]).toContain('pri-1 · "Trusted evals"');
    expect(prompts[1]).toContain("get grader faults under ten percent");
    expect(prompts[1]).not.toContain("start the grader work");
    expect(r.outputs.map((o: any) => o.sessions)).toEqual([["jx7old"], ["jx7team"]]);
    expect(r.priorities).toHaveLength(1);
    expect(r.priorities[0].sessions.map((s: any) => s.id).sort()).toEqual(["jx7old", "jx7team"]);
    expect(await w.priorities()).toEqual([]);
    expect(await w.runs()).toEqual([]);
  });
});
