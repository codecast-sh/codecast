// The per-session classifier (priorityClassifier.ts, lib/priorityClassifierHook.ts):
// a session's first title or pin asks it once, behind its flag; it reads only
// the person's active priorities in the session's own workspace, with each
// milestone's tasks, plan and project; it never reads a role's seat or a
// machine's run; it writes through linkSession as the classifier's, under the
// person and known links and over the pass; "new" leaves the session alone;
// and a pass that creates a priority or milestone asks again about what it left.
import { describe, expect, setDefaultTimeout, setSystemTime, afterEach, test } from "bun:test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { nextShortId } from "./counters";
import { performSetThreadState } from "./conversations";
import { linkSession } from "./lib/priorityLinks";
import { CLASSIFIER_DAILY_USD, RERUN_DELAY_MS } from "./lib/priorityClassifierHook";
import { parseClassifierReply, type ClassifierInput } from "./lib/priorityClassifier";
import { DAY, H, pass, stubModel, world } from "./priorityPassRun.testkit";

setDefaultTimeout(60_000);

const model = stubModel();
afterEach(() => setSystemTime());
const fn = internal as any;
type World = Awaited<ReturnType<typeof world>>;

const isClassifier = (prompt: string) => prompt.includes("# The session");
const answer = (choice: string) => JSON.stringify({ reason: "fits", choice });
const step = (key: string, title: string, refs: Array<{ kind: "task"; id: string }> = [], extra: Record<string, unknown> = {}) =>
  ({ key, title, tier: "critical", tier_set_by: "pass", refs, done: false, ...extra });

/** The world with the classifier on in Acme, Ana's tasks and plan there, and her priorities: two in Acme, one personal, one set aside; Ben's in Acme. */
async function classifierWorld(flag = true) {
  const w = await world();
  const ids = await w.t.run(async (ctx) => {
    await ctx.db.patch(w.acme, { features: { priorities: true, ...(flag ? { priority_classifier: true } : {}) } } as any);
    const project = await ctx.db.insert("projects", { title: "Evals", workspace: w.team, user_id: w.ana, created_at: 1, updated_at: 1 } as any);
    const plan = await ctx.db.insert("plans", { short_id: "pl-7", title: "Grader rollout", status: "active", workspace: w.team, user_id: w.ana, created_at: 1, updated_at: 1 } as any);
    await ctx.db.insert("tasks", { short_id: "ct-11", title: "Retry flaky grader calls", status: "in_progress", workspace: w.team, user_id: w.ana, plan_id: plan, project_id: project, created_at: 1, updated_at: 1 } as any);
    const prio = async (user: Id<"users">, workspace: string, title: string, steps: unknown[], status = "active", last = w.now) =>
      ctx.db.insert("priorities", {
        user_id: user, workspace, short_id: await nextShortId(ctx.db, "pri"), title, summary: `${title}, going`, status, ai_rank: 1, steps,
        first_seen_at: 1, last_active_at: last, pass_at: 1, created_at: 1, updated_at: 1, session_count: 0,
      } as any);
    const grader = await prio(w.ana, w.team, "Trusted evals", [step("s1", "Grader faults under 10%", [{ kind: "task", id: "ct-11" }]), step("s2", "Docs", [], { dropped: true })]);
    const deploys = await prio(w.ana, w.team, "Simple deploys", [step("s1", "One deploy command")], "active", w.now - H);
    const personal = await prio(w.ana, `user:${w.ana}`, "Laptop stops crashing", [step("s1", "Find the leak")]);
    const asideP = await prio(w.ana, w.team, "Old migration", [step("s1", "Backfill")], "set_aside");
    const bens = await prio(w.ben, w.team, "Ben's launch", [step("s1", "Launch")]);
    return { grader, deploys, personal, asideP, bens };
  });
  return { ...w, ...ids };
}

/** Runs what a write scheduled to run now (the classify action and its settle). */
async function drain(w: World) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await w.t.finishInProgressScheduledFunctions();
  }
}

const title = async (w: World, conv: Id<"conversations">, text: string) => {
  await w.t.mutation(fn.titleGeneration.setTitleAndSubtitle, { conversation_id: conv, title: text, subtitle: "sub" });
  await drain(w);
};
const pin = async (w: World, conv: Id<"conversations">, text: string) => {
  await w.t.run(async (ctx: any) => performSetThreadState(ctx, (await ctx.db.get(conv))!, text, "working"));
  await drain(w);
};
const classifications = (w: World, conv?: Id<"conversations">) =>
  w.t.run(async (ctx) => (await ctx.db.query("priority_classifications").collect()).filter((r) => !conv || r.conversation_id === conv));
const classifierPrompts = () => model.prompts.filter(isClassifier);

describe("when it asks", () => {
  test("a session's first title asks once; a later pin does not ask again", async () => {
    const w = await classifierWorld();
    model.reply = () => answer("pri-1/s1");
    await title(w, w.teamConv, "Retry the flaky grader");
    await pin(w, w.teamConv, "Grader retries in");
    expect(classifierPrompts()).toHaveLength(1);
    expect(await classifications(w, w.teamConv)).toMatchObject([{ status: "placed", priority_id: w.grader, step_key: "s1" }]);
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: w.grader, priority_step_key: "s1", priority_set_by: "classifier" });
    expect((await w.t.run((ctx) => ctx.db.get(w.grader)))?.session_count).toBe(1);
  });

  test("a first pin asks when no title came first", async () => {
    const w = await classifierWorld();
    model.reply = () => answer("pri-2");
    await pin(w, w.oldConv, "Deploy script consolidated");
    const conv = await w.conversation(w.oldConv);
    expect(conv).toMatchObject({ priority_id: w.deploys, priority_set_by: "classifier" });
    expect(conv?.priority_step_key).toBeUndefined();
  });

  test("flag off: no ask, no model call, and a pass's new priority schedules no re-run", async () => {
    const w = await classifierWorld(false);
    await title(w, w.teamConv, "Retry the flaky grader");
    await pin(w, w.oldConv, "Deploy script consolidated");
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [{ ref: "new-1", title: "Fresh", summary: "", status: "active", ai_rank: 3, serves: null, steps: [], last_active_at: w.now, first_seen_at: w.now, pass_at: w.now }], updates: [], merges: [], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    expect(model.prompts).toHaveLength(0);
    expect(await classifications(w)).toHaveLength(0);
    const reruns = await w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.startsWith("priorityClassifier")));
    expect(reruns).toHaveLength(0);
  });

  test("never a role's standing session, a trigger's run, a workflow's run log, its station agent or a Task-tool subagent", async () => {
    const w = await classifierWorld();
    model.reply = () => answer("pri-1");
    const machine = await w.t.run(async (ctx) => {
      const make = (short_id: string, fields: Record<string, unknown>) =>
        ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: short_id, short_id, team_id: w.acme, is_private: false, team_visibility: "full", started_at: 1, updated_at: 1, message_count: 3, status: "active", ...fields } as any);
      const seat = await ctx.db.insert("org_roles", { team_id: w.acme, title: "Head of Evals", created_at: 1 } as any);
      const task = await ctx.db.insert("agent_tasks", { user_id: w.ana, title: "Nightly", prompt: "check", status: "scheduled", created_at: 1 } as any);
      const runRow = await ctx.db.insert("workflow_runs", { user_id: w.ana, status: "running", created_at: 1 } as any);
      return [
        await make("jx7role", { standing_role_id: seat }),
        await make("jx7trig", { agent_task_id: task }),
        await make("jx7log", { workflow_run_id: runRow, is_workflow_primary: true }),
        await make("jx7stat", { workflow_run_id: runRow, is_workflow_sub: true }),
        await make("jx7sub", { is_subagent: true, parent_conversation_id: w.teamConv }),
      ];
    });
    for (const id of machine) {
      await title(w, id, "Duty turn");
      await pin(w, id, "Duty done");
    }
    expect(model.prompts).toHaveLength(0);
    expect(await classifications(w)).toHaveLength(0);
  });

  test("a session already linked is never asked about", async () => {
    const w = await classifierWorld();
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { priority_id: w.deploys, priority_set_by: "link" } as any));
    await title(w, w.teamConv, "Retry the flaky grader");
    expect(model.prompts).toHaveLength(0);
  });

  test("past the pair's daily cap, nothing is asked", async () => {
    const w = await classifierWorld();
    await w.t.run((ctx) => ctx.db.insert("priority_classifications", { user_id: w.ana, workspace: w.team, conversation_id: w.oldConv, at: Date.now() - H, status: "new", model: "m", held_usd: 0, cost_usd: CLASSIFIER_DAILY_USD }));
    await title(w, w.teamConv, "Retry the flaky grader");
    expect(model.prompts).toHaveLength(0);
    expect(await classifications(w, w.teamConv)).toHaveLength(0);
  });
});

describe("what it reads", () => {
  test("only the person's active priorities in the session's own workspace, each milestone with its tasks, plan and project", async () => {
    const w = await classifierWorld();
    let prompt = "";
    model.reply = (p) => ((prompt = p), answer("new"));
    await title(w, w.teamConv, "Retry the flaky grader");
    expect(prompt).toContain('pri-1 "Trusted evals"');
    expect(prompt).toContain("pri-1/s1 [critical] Grader faults under 10%");
    expect(prompt).toContain('task ct-11 "Retry flaky grader calls" (in_progress) · plan pl-7 "Grader rollout" · project "Evals"');
    expect(prompt).toContain('pri-2 "Simple deploys"');
    // Not the personal workspace's, not one set aside, not a teammate's, not a dropped milestone.
    for (const absent of ["Laptop stops crashing", "Old migration", "Ben's launch", "Docs"]) expect(prompt).not.toContain(absent);
    expect(prompt).toContain("Title: Retry the flaky grader");
    // Most recently active first.
    expect(prompt.indexOf("Trusted evals")).toBeLessThan(prompt.indexOf("Simple deploys"));
  });

  test("a personal session reads only the personal priorities", async () => {
    const w = await classifierWorld();
    let prompt = "";
    model.reply = (p) => ((prompt = p), answer("pri-3/s1"));
    await title(w, w.personalConv, "Find the memory leak");
    expect(prompt).toContain("Laptop stops crashing");
    expect(prompt).not.toContain("Trusted evals");
    expect(await w.conversation(w.personalConv)).toMatchObject({ priority_id: w.personal, priority_step_key: "s1" });
  });

  test("a reply naming a priority it was not shown places nothing", () => {
    const input: ClassifierInput = { person: "Ana", session: { title: "", first_prompt: "", pin: null, typed: [], tasks: [] }, priorities: [{ short_id: "pri-1", title: "A", summary: "", examples: [], milestones: [{ key: "s1", title: "m", tier: "critical", done: false, tasks: [], examples: [] }] }] };
    expect(parseClassifierReply({ choice: "pri-9/s1" }, input)).toBeNull();
    expect(parseClassifierReply({ choice: "PRI-1/s7" }, input)).toEqual({ priority: "pri-1", step: null });
    expect(parseClassifierReply({ choice: "pri-1/s1" }, input)).toEqual({ priority: "pri-1", step: "s1" });
    expect(parseClassifierReply({ choice: "new" }, input)).toBe("new");
    expect(parseClassifierReply({}, input)).toBeNull();
  });
});

describe("precedence: the person > a known link > the classifier > the pass", () => {
  test("a person's placement or a known link made while the call ran stands", async () => {
    const w = await classifierWorld();
    model.reply = () => answer("pri-1/s1");
    for (const [conv, by] of [[w.teamConv, "person"], [w.oldConv, "link"]] as const) {
      await w.t.mutation(fn.titleGeneration.setTitleAndSubtitle, { conversation_id: conv, title: "Retry the flaky grader", subtitle: "sub" });
      // Mapped before the scheduled call runs.
      await w.t.run((ctx) => ctx.db.patch(conv, { priority_id: w.deploys, priority_set_by: by } as any));
      await drain(w);
      expect(await w.conversation(conv)).toMatchObject({ priority_id: w.deploys, priority_set_by: by });
      expect((await classifications(w, conv))[0]).toMatchObject({ status: "skipped" });
    }
  });

  test("the classifier's link never overwrites a known one, and a known link overwrites the classifier's", async () => {
    const w = await classifierWorld();
    await w.t.run(async (ctx: any) => {
      await ctx.db.patch(w.teamConv, { priority_id: w.deploys, priority_set_by: "link" });
      expect(await linkSession(ctx, (await ctx.db.get(w.teamConv))!, w.grader, "s1", "classifier")).toBe(false);
      await ctx.db.patch(w.oldConv, { priority_id: w.deploys, priority_set_by: "classifier" });
      expect(await linkSession(ctx, (await ctx.db.get(w.oldConv))!, w.grader, "s1")).toBe(true);
    });
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: w.deploys, priority_set_by: "link" });
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: w.grader, priority_set_by: "link" });
  });

  test("the pass neither moves nor unmaps a session the classifier or a known link placed; it still moves its own", async () => {
    const w = await classifierWorld();
    const own = await w.t.run(async (ctx) => {
      await ctx.db.patch(w.teamConv, { priority_id: w.grader, priority_step_key: "s1", priority_set_by: "classifier" } as any);
      await ctx.db.patch(w.oldConv, { priority_id: w.grader, priority_set_by: "link" } as any);
      return ctx.db.insert("conversations", {
        user_id: w.ana, agent_type: "claude_code", session_id: "jx7free", short_id: "jx7free", team_id: w.acme, is_private: false, team_visibility: "full",
        started_at: 1, updated_at: 1, message_count: 3, status: "active", priority_id: w.grader,
      } as any);
    });
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [], merges: [], sessions: [{ session: "jx7team", priority: "pri-2", step_key: "s1" }, { session: "jx7free", priority: "pri-2", step_key: "s1" }], unmap: ["jx7old"], notes: [], rewritten: [] },
    });
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: w.grader, priority_step_key: "s1", priority_set_by: "classifier" });
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: w.grader, priority_set_by: "link" });
    expect(await w.conversation(own)).toMatchObject({ priority_id: w.deploys, priority_step_key: "s1" });
  });

  test("a pass's merge carries the classifier's mark to the survivor", async () => {
    const w = await classifierWorld();
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { priority_id: w.deploys, priority_set_by: "classifier" } as any));
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [], merges: [{ short_id: "pri-2", merged_into: "pri-1" }], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: w.grader, priority_set_by: "classifier" });
  });
});

describe('"new" and the re-run', () => {
  test('"new" leaves the session unassigned', async () => {
    const w = await classifierWorld();
    model.reply = () => answer("new");
    await title(w, w.teamConv, "Answer a billing question");
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    expect(await classifications(w, w.teamConv)).toMatchObject([{ status: "new" }]);
  });

  test("a pass's new priority or milestone asks again, after RERUN_DELAY_MS, about the sessions still unassigned, once each", async () => {
    const w = await classifierWorld();
    model.reply = () => answer("new");
    await title(w, w.teamConv, "Answer a billing question");
    await title(w, w.oldConv, "Billing export");
    // One of the two got mapped meanwhile; it is not asked again.
    await w.t.run((ctx) => ctx.db.patch(w.oldConv, { priority_id: w.deploys } as any));
    model.prompts = [];
    const t0 = Date.now();
    const plan = (creates: unknown[], updates: unknown[] = []) => w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates, updates, merges: [], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    await plan([{ ref: "new-1", title: "Billing works", summary: "", status: "active", ai_rank: 3, serves: null, steps: [step("s1", "Invoices export")], last_active_at: Date.now() + 1, first_seen_at: t0, pass_at: t0 }]);
    // A second run of the chain adds a milestone: its re-run finds the session asked already.
    const grader = await w.t.run((ctx) => ctx.db.get(w.grader));
    await plan([], [{ short_id: "pri-1", patch: { steps: [...grader!.steps, step("s3", "Grader in CI")] } }]);
    const reruns = await w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name === "priorityClassifier:rerun" && j.state.kind === "pending"));
    expect(reruns).toHaveLength(2);
    expect(reruns[0].scheduledTime).toBeGreaterThanOrEqual(t0 + RERUN_DELAY_MS);
    model.reply = (p) => {
      expect(p).toContain("Billing works");
      return answer("pri-6/s1");
    };
    setSystemTime(new Date(t0 + RERUN_DELAY_MS + 1_000));
    for (const job of reruns) {
      await w.t.run((ctx) => ctx.scheduler.cancel(job._id));
      await w.t.mutation(fn.priorityClassifier.rerun, job.args[0]);
      await drain(w);
    }
    expect(classifierPrompts()).toHaveLength(1);
    const billing = (await w.priorities()).find((p) => p.title === "Billing works")!;
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: billing._id, priority_step_key: "s1", priority_set_by: "classifier" });
    expect((await w.conversation(w.oldConv))?.priority_id).toBe(w.deploys);
  });

  test("the calibration replay asks about each session it would ask about live, against the priorities handed to it, and writes nothing", async () => {
    const w = await classifierWorld();
    const seat = await w.t.run((ctx) => ctx.db.insert("org_roles", { team_id: w.acme, title: "Head of Evals", created_at: 1 } as any));
    const role = await w.t.run((ctx) => ctx.db.insert("conversations", {
      user_id: w.ana, agent_type: "claude_code", session_id: "jx7role", short_id: "jx7role", title: "Duty", team_id: w.acme, is_private: false, team_visibility: "full",
      started_at: 1, updated_at: 1, message_count: 3, status: "active", standing_role_id: seat,
    } as any));
    await w.send(w.ana, w.teamConv, w.now - 3 * H, "retry the flaky grader calls");
    await w.send(w.ana, w.oldConv, w.now - 2 * H, "answer the billing question");
    await w.send(w.ana, role, w.now - 2 * H, "duty");
    const seeded = [{
      short_id: "pri-1", title: "Grader", summary: "Grader", status: "active", person_pos: null, ai_rank: null, serves: null, last_active_at: 1, sessions: [],
      steps: [step("s1", "Faults under 10%", [{ kind: "task", id: "ct-11" }])],
    }];
    model.reply = (p) => {
      if (p.includes("retry the flaky grader")) {
        expect(p).toContain('task ct-11 "Retry flaky grader calls" (in_progress)');
        return answer("pri-1/s1");
      }
      // The later session sees the earlier one as an example under its milestone.
      expect(p).toContain('sessions: "Session jx7team"');
      return answer("new");
    };
    const r = await w.t.action(fn.priorityClassifierEval.evalClassify, { user_id: w.ana, workspace: w.team, window_start: w.now - DAY, window_end: w.now, priorities: seeded });
    expect(r.placements.map((p: any) => [p.session, p.choice])).toEqual([["jx7team", { priority: "pri-1", step: "s1" }], ["jx7old", "new"]]);
    expect(r.sessions_read.map((s: any) => s.id).sort()).toEqual(["jx7old", "jx7role", "jx7team"]);
    expect(r.priorities[0].sessions.map((s: any) => [s.id, s.step_key])).toEqual([["jx7team", "s1"]]);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    expect(await classifications(w)).toHaveLength(0);
  });

  test("a plan with no new priority or milestone asks for no re-run", async () => {
    const w = await classifierWorld();
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [{ short_id: "pri-1", patch: { title: "Trusted evals, renamed" } }], merges: [], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    const reruns = await w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name === "priorityClassifier:rerun"));
    expect(reruns).toHaveLength(0);
  });
});
