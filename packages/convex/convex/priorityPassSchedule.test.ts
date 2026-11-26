// The pass runs on activity (priorityPassSchedule.ts, lib/priorityPassSchedule.ts):
// a burst of asks becomes one pass PASS_DEBOUNCE_MS after its last ask, steady
// activity waits no longer than PASS_MAX_WAIT_MS, automatic passes of a pair
// start PASS_MIN_GAP_MS apart, every trigger kind asks, and no 3-hourly cron
// remains. Also the `cast state --serves` hint reaching the pass's input.
import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import crons from "./crons";
import { performSetThreadState } from "./conversations";
import { patchTask } from "./lib/taskWrite";
import { priorityPassRequest } from "./lib/priorityPass";
import { PASS_DEBOUNCE_MS, PASS_MAX_WAIT_MS, PASS_MIN_GAP_MS, passActivity, sessionActivity } from "./lib/priorityPassSchedule";
import { askClassifier } from "./lib/priorityClassifierHook";
import { linkFromPlan, linkFromTask, linkSession, pullRequestClosed } from "./lib/priorityLinks";
import { passAllowedAt } from "./priorityPassSchedule";
import { PRIORITY_PASS_DAILY_USD } from "./priorityPassRun";
import { DAY, H, pass, stubModel, world } from "./priorityPassRun.testkit";

setDefaultTimeout(60_000);

const model = stubModel();
afterEach(() => setSystemTime());

const fn = internal as any;
const MIN = 60_000;
type World = Awaited<ReturnType<typeof world>>;

/** Runs the jobs a write scheduled to run now (a hook's request, a fire's pass), and what they schedule in turn. */
async function settle(w: World) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await w.t.finishInProgressScheduledFunctions();
  }
}

const jobs = (w: World, name: string, kind = "pending") =>
  w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name === name && (!kind || j.state.kind === kind)));

const scheduleOf = (w: World, user: Id<"users">, workspace: string) =>
  w.t.run((ctx) => ctx.db.query("priority_pass_schedules").withIndex("by_user_workspace", (q) => q.eq("user_id", user).eq("workspace", workspace)).first());

/** A pin on `conv` at time `at` through the one pin write path. */
async function pinAt(w: World, conv: Id<"conversations">, at: number, text: string, status: "working" | "done" = "working", serves?: string) {
  setSystemTime(new Date(at));
  await w.t.run(async (ctx: any) => performSetThreadState(ctx, (await ctx.db.get(conv))!, text, status, null, serves));
  await settle(w);
}

/** The pair's pending fire job, run at its time: what it did. */
async function fireAt(w: World, at: number): Promise<string> {
  const [job] = await jobs(w, "priorityPassSchedule:fire");
  expect(job).toBeDefined();
  setSystemTime(new Date(at));
  await w.t.run((ctx) => ctx.scheduler.cancel(job._id));
  const out = await w.t.mutation(fn.priorityPassSchedule.fire, job.args[0]);
  await settle(w);
  return out;
}

describe("debounce", () => {
  test("several pins in a burst become one pass, PASS_DEBOUNCE_MS after the last", async () => {
    const w = await world();
    const t0 = Date.now();
    for (const [i, text] of ["Reading the grader", "Grader faults at 12%", "Grader faults at 9%"].entries()) await pinAt(w, w.teamConv, t0 + 2 * i * MIN, text);
    const row = await scheduleOf(w, w.ana, w.team);
    expect(row).toMatchObject({ due_at: t0 + 4 * MIN + PASS_DEBOUNCE_MS, since: t0 });
    // One job owns the burst: the later pins only moved its time.
    expect(await jobs(w, "priorityPassSchedule:fire")).toHaveLength(1);
    // The job fires at the first pin's time + debounce, finds the pass moved on, and waits for it.
    expect(await fireAt(w, t0 + PASS_DEBOUNCE_MS)).toBe("waiting");
    expect(await fireAt(w, t0 + 4 * MIN + PASS_DEBOUNCE_MS)).toBe("started");
    expect(await jobs(w, "priorityPassSchedule:fire")).toHaveLength(0);
    // The one pass read all three pins.
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("Grader faults at 9%");
    expect((await w.runs()).map((r) => r.status)).toEqual(["ok"]);
  });

  test("steady activity holds the pass off no longer than PASS_MAX_WAIT_MS after the burst began", async () => {
    const w = await world();
    const t0 = Date.now();
    // A pin every five minutes: each would push the pass ten minutes on.
    for (let i = 0; i <= 5; i++) await pinAt(w, w.teamConv, t0 + i * 5 * MIN, `Step ${i}`);
    expect((await scheduleOf(w, w.ana, w.team))!.due_at).toBe(t0 + PASS_MAX_WAIT_MS);
    expect(await fireAt(w, t0 + PASS_MAX_WAIT_MS)).toBe("started");
  });

  test("re-pinning the same words asks for nothing", async () => {
    const w = await world();
    const t0 = Date.now();
    await pinAt(w, w.teamConv, t0, "Grader faults at 14%");
    expect(await scheduleOf(w, w.ana, w.team)).toBeNull();
  });
});

describe("rate limit", () => {
  test("after a pass starts, the next one waits PASS_MIN_GAP_MS however soon activity comes", async () => {
    const w = await world();
    const t0 = Date.now();
    await pinAt(w, w.teamConv, t0, "First");
    expect(await fireAt(w, t0 + PASS_DEBOUNCE_MS)).toBe("started");
    const started = t0 + PASS_DEBOUNCE_MS;
    await pinAt(w, w.teamConv, started + 5 * MIN, "Second");
    expect(await fireAt(w, started + 5 * MIN + PASS_DEBOUNCE_MS)).toBe("waiting");
    expect((await scheduleOf(w, w.ana, w.team))!.due_at).toBe(started + PASS_MIN_GAP_MS);
    // More activity while the gap holds the pass neither moves it nor adds a job.
    await pinAt(w, w.teamConv, started + 30 * MIN, "Third");
    expect((await scheduleOf(w, w.ana, w.team))!.due_at).toBe(started + PASS_MIN_GAP_MS);
    expect(await jobs(w, "priorityPassSchedule:fire")).toHaveLength(1);
    expect(await jobs(w, "priorityPassSchedule:request", "")).toHaveLength(2);
    expect(await fireAt(w, started + PASS_MIN_GAP_MS)).toBe("started");
    expect(model.prompts).toHaveLength(2);
  });

  test("a pass run by hand (`cast priorities run`) holds the next automatic one for the gap too", async () => {
    const w = await world();
    const t0 = Date.now();
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: t0 - 20 * MIN, finished_at: t0 - 19 * MIN, status: "ok", cost_usd: 0.02, cursor_at: t0 - 25 * MIN, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await pinAt(w, w.teamConv, t0, "After the manual run");
    expect(await fireAt(w, t0 + PASS_DEBOUNCE_MS)).toBe("waiting");
    const [job] = await jobs(w, "priorityPassSchedule:fire");
    expect(Math.round(job.scheduledTime)).toBe(t0 - 20 * MIN + PASS_MIN_GAP_MS);
    // The list says when it will really run.
    const asAna = w.t.withIdentity({ subject: `${w.ana}|session` });
    expect((await asAna.query((api as any).priorities.list, { workspace: w.team })).next_pass_at).toBe(t0 - 20 * MIN + PASS_MIN_GAP_MS);
  });
  /**
   * Two days of pins from a person (every 20 minutes) and a role (every 5),
   * with due jobs fired on time and each pass priced by `costOf` (hours since
   * the last pass): the passes started, as [hours from the start, cost].
   */
  async function twoDays(costOf: (hoursSinceLast: number) => number): Promise<Array<[number, number]>> {
    const w = await world();
    const role = await w.t.run(async (ctx) => {
      const seat = await ctx.db.insert("org_roles", { team_id: w.acme, title: "Head of Evals", created_at: Date.now() } as any);
      return ctx.db.insert("conversations", {
        user_id: w.ana, agent_type: "claude_code", session_id: "jx7role", short_id: "jx7role", title: "Head of Evals", started_at: Date.now(), updated_at: Date.now(),
        message_count: 3, status: "active", team_id: w.acme, is_private: false, team_visibility: "full", standing_role_id: seat,
      } as any);
    });
    const t0 = Date.now();
    // The pair's first pass (a catch-up) ran an hour ago: every pass here spends from the daily ceiling.
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: t0 - H, finished_at: t0 - H, status: "ok", catch_up: true, cost_usd: 0.2, cursor_at: t0 - H, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    let lastStart = t0 - H;
    for (let i = 0, at = t0; at < t0 + 2 * DAY; i++, at += 5 * MIN) {
      for (const job of await jobs(w, "priorityPassSchedule:fire")) {
        if (job.scheduledTime > at) continue;
        // Input is priced at $2 per million tokens.
        model.usage = { input_tokens: Math.round(costOf((at - lastStart) / H) * 500_000), output_tokens: 0 };
        if ((await fireAt(w, at)) === "started") lastStart = at;
      }
      await pinAt(w, role, at, `Role tick ${i}`);
      if (i % 4 === 0) await pinAt(w, w.teamConv, at, `Person step ${i}`);
    }
    const runs = (await w.runs()).filter((r) => r.started_at >= t0);
    expect(runs.filter((r) => r.error === "daily ceiling")).toEqual([]);
    return runs.filter((r) => r.status === "ok").map((r) => [(r.started_at - t0) / H, r.cost_usd ?? 0]);
  }

  /** No day's spend reaches the ceiling wherever the day starts, and while activity goes on no pass waits more than six hours. */
  function expectSpread(passes: Array<[number, number]>) {
    for (const [h] of passes) {
      const day = passes.filter(([x]) => x > h - 24 && x <= h).reduce((sum, [, c]) => sum + c, 0);
      expect(day).toBeLessThanOrEqual(PRIORITY_PASS_DAILY_USD);
    }
    const times = [0, ...passes.map(([h]) => h), 48];
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThanOrEqual(6);
  }

  test("two days at a flat $0.23 a pass (the heaviest pair's measured cost): passes come every few hours all day, under the ceiling", async () => {
    const passes = await twoDays(() => 0.23);
    expectSpread(passes);
    expect(passes.length).toBeGreaterThanOrEqual(8);
  }, 600_000);

  test("two days with each pass dearer the longer since the last ($0.03 + $0.03 an hour): passes stay spread, never collapsing to one a day", async () => {
    const passes = await twoDays((h) => 0.03 + 0.03 * h);
    expectSpread(passes);
    expect(passes.filter(([h]) => h >= 24).length).toBeGreaterThanOrEqual(8);
  }, 600_000);

  test("passAllowedAt: a token bucket of dollars, refilled at 80% of the ceiling a day, replayed from the day's runs (at a $1.50 ceiling)", () => {
    const allowed = (day: any[], now: number) => passAllowedAt(day, now, 1.5);
    const now = Date.now();
    const at = (ago: number, cost_usd: number, catch_up = false) => ({ started_at: now - ago, status: "ok", cost_usd, ...(catch_up ? { catch_up } : {}) }) as any;
    // $1.20 a day is $0.05 an hour.
    const refill = (dollars: number) => (dollars / 0.05) * H;
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(1_000);
    expect(allowed([], now)).toBe(-Infinity);
    // Cheap passes: the bucket always holds one, so the floor decides.
    expect(allowed([at(H, 0.01), at(3 * H, 0.01)], now)).toBe(now - H + PASS_MIN_GAP_MS);
    // $0.23 a pass: the bucket holds $0.30 (the ceiling's room beside a day's refill). After one pass $0.12 is left, $0.11 short.
    near(allowed([at(H, 0.23)], now), now + refill(0.11));
    // A chain's runs are one pass.
    near(allowed([at(H - MIN, 0.115), at(H, 0.115)], now), now + refill(0.11));
    // Three in three hours put the bucket $0.24 in debt: the next waits for $0.47.
    near(allowed([at(H, 0.23), at(2 * H, 0.23), at(3 * H, 0.23)], now), now + refill(0.47));
    // A pass dearer than the room holds one pass, and the refill slows to keep the day under the ceiling ($0.90 a day).
    near(allowed([at(H, 0.6)], now), now + (0.6 / (0.9 / 24) - 1) * H);
    // A catch-up spends its own allowance.
    expect(allowed([at(H, 2, true)], now)).toBe(now - H + PASS_MIN_GAP_MS);
  });
});

describe("each trigger asks for its owner's pass", () => {
  test("a pin, and a session going done", async () => {
    const w = await world();
    await pinAt(w, w.teamConv, Date.now(), "Working on it");
    await pinAt(w, w.benConv, Date.now(), "Shipped", "done");
    expect(await scheduleOf(w, w.ana, w.team)).not.toBeNull();
    expect(await scheduleOf(w, w.ben, w.team)).not.toBeNull();
  });

  test("a decision card answered", async () => {
    const w = await world();
    const decision = await w.t.run((ctx: any) => ctx.db.insert("session_decisions", {
      conversation_id: w.personalConv, session_id: "jx7mine", user_id: w.ana, question: "Flip the flag?", options: [{ label: "Yes" }, { label: "No" }],
      blocking: true, status: "pending", created_at: Date.now(),
    }));
    await w.t.withIdentity({ subject: `${w.ana}|session` }).mutation(api.sessionDecisions.resolve, { decision_id: decision, status: "answered", answer_index: 0 });
    await settle(w);
    expect(await scheduleOf(w, w.ana, `user:${w.ana}`)).not.toBeNull();
  });

  test("a task closing", async () => {
    const w = await world();
    const task = await w.t.run((ctx) => ctx.db.insert("tasks", {
      user_id: w.ana, workspace: w.team, short_id: "ct-1", title: "Grader", status: "open", task_type: "task", priority: "medium", source: "human", created_at: Date.now(), updated_at: Date.now(),
    } as any));
    await w.t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(task), { status: "done", closed_at: Date.now() }));
    await settle(w);
    expect(await scheduleOf(w, w.ana, w.team)).not.toBeNull();
  });

  test("a task a machine's session closes, or a card a machine's session asked, asks for nothing; the person's session asks", async () => {
    const w = await world();
    const { seat, task } = await w.t.run(async (ctx) => {
      const role = await ctx.db.insert("org_roles", { team_id: w.acme, title: "Head of Evals", created_at: Date.now() } as any);
      const seat = await ctx.db.insert("conversations", {
        user_id: w.ana, agent_type: "claude_code", session_id: "jx7seat", short_id: "jx7seat", title: "Seat", started_at: Date.now(), updated_at: Date.now(),
        message_count: 3, status: "active", team_id: w.acme, is_private: false, team_visibility: "full", standing_role_id: role,
      } as any);
      const task = await ctx.db.insert("tasks", {
        user_id: w.ana, workspace: w.team, short_id: "ct-1", title: "Grader", status: "open", task_type: "task", priority: "medium", source: "human", created_at: Date.now(), updated_at: Date.now(),
      } as any);
      return { seat, task };
    });
    await w.t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(task), { status: "done", closed_at: Date.now() }, await ctx.db.get(seat)));
    const decision = await w.t.run((ctx: any) => ctx.db.insert("session_decisions", {
      conversation_id: seat, session_id: "jx7seat", user_id: w.ana, question: "Flip the flag?", options: [{ label: "Yes" }, { label: "No" }],
      blocking: true, status: "pending", created_at: Date.now(),
    }));
    await w.t.withIdentity({ subject: `${w.ana}|session` }).mutation(api.sessionDecisions.resolve, { decision_id: decision, status: "answered", answer_index: 0 });
    await settle(w);
    expect(await scheduleOf(w, w.ana, w.team)).toBeNull();
    // The same close from the person's own session asks.
    await w.t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(task), { status: "open", closed_at: undefined }, await ctx.db.get(w.teamConv)));
    await settle(w);
    expect(await scheduleOf(w, w.ana, w.team)).not.toBeNull();
  });

  test("a correction, and its pass reads it with nothing else new", async () => {
    const w = await world();
    const t0 = Date.now();
    await w.t.run((ctx) => ctx.db.insert("priorities", {
      user_id: w.ana, workspace: w.team, short_id: "pri-1", title: "Trusted evals", summary: "", status: "active", rank: 1, rank_set_by: "pass",
      steps: [], first_seen_at: t0, last_active_at: t0, pass_at: t0, created_at: t0, updated_at: t0, session_count: 0,
    } as any));
    setSystemTime(new Date(t0));
    await w.t.withIdentity({ subject: `${w.ana}|session` }).mutation((api as any).priorities.correct, { short_id: "pri-1", text: "This is about the grader, not the evals" });
    await settle(w);
    expect((await scheduleOf(w, w.ana, w.team))!.due_at).toBe(t0 + PASS_DEBOUNCE_MS);
    expect(await fireAt(w, t0 + PASS_DEBOUNCE_MS)).toBe("started");
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("This is about the grader, not the evals");
    expect((await w.t.run((ctx) => ctx.db.query("priority_corrections").collect())).map((c) => c.status)).toEqual(["applied"]);
  });

  test("where the feature is off, activity schedules nothing at all", async () => {
    const w = await world();
    await pinAt(w, w.otherConv, Date.now(), "Work in Other");
    await pinAt(w, w.carlConv, Date.now(), "Carl's work");
    expect(await scheduleOf(w, w.ana, `team:${w.other}`)).toBeNull();
    expect(await jobs(w, "priorityPassSchedule:request", "")).toHaveLength(0);
    expect(await jobs(w, "priorityPassSchedule:fire", "")).toHaveLength(0);
  });

  test("a role's standing session, a trigger's run, a workflow's run log and its station agents pin without asking; the person's session that ran the workflow asks", async () => {
    const w = await world();
    const { machines, caller } = await w.t.run(async (ctx) => {
      const seat = await ctx.db.insert("org_roles", { team_id: w.acme, title: "Head of Evals", created_at: Date.now() } as any);
      const task = await ctx.db.insert("agent_tasks", { user_id: w.ana, title: "Nightly", prompt: "check", status: "scheduled", created_at: Date.now() } as any);
      const runRow = await ctx.db.insert("workflow_runs", { user_id: w.ana, status: "running", created_at: Date.now() } as any);
      const conv = (i: number, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
        user_id: w.ana, agent_type: "claude_code", session_id: `jx7mach${i}`, short_id: `jx7mach${i}`, title: "Machine", started_at: Date.now(), updated_at: Date.now(),
        message_count: 3, status: "active", team_id: w.acme, is_private: false, team_visibility: "full", ...fields,
      } as any);
      const machines = [
        await conv(0, { standing_role_id: seat }),
        await conv(1, { agent_task_id: task }),
        await conv(2, { workflow_run_id: runRow, is_workflow_primary: true }),
        await conv(3, { workflow_run_id: runRow, is_workflow_sub: true }),
      ];
      return { machines, caller: await conv(4, { workflow_run_id: runRow }) };
    });
    for (const id of machines) await pinAt(w, id, Date.now(), "Ran the nightly check");
    expect(await jobs(w, "priorityPassSchedule:request", "")).toHaveLength(0);
    await pinAt(w, caller, Date.now(), "Ran the review workflow; two findings fixed");
    expect(await jobs(w, "priorityPassSchedule:request", "")).toHaveLength(1);
    expect(await scheduleOf(w, w.ana, w.team)).not.toBeNull();
  });
});

describe("with priorities off, a pin, title, PR close or link costs about a read", () => {
  /** Runs `fn` against a db that records each read: a get, or a query's table. */
  async function reads(w: World, fn: (ctx: any) => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    await w.t.run(async (ctx: any) => {
      const db = new Proxy(ctx.db, {
        get(target: any, prop: string) {
          if (prop === "query") return (table: string) => (seen.push(`query ${table}`), target.query(table));
          if (prop === "get") return (id: any) => (seen.push("get"), target.get(id));
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await fn({ ...ctx, db });
    });
    return seen;
  }

  test("Carl's team Other has priorities off and so does his personal workspace (no team of his has it on)", async () => {
    const w = await world();
    const { carlConv, carl, other } = w;
    const conv = await w.conversation(carlConv);
    // The pass: the team's flag, one read.
    expect(await reads(w, (ctx) => passActivity(ctx, carl, `team:${other}`))).toEqual(["get"]);
    // A session: its team's flag, then whether any team of its owner has it on; never the session's priority tables, or its owner.
    const pinCost = await reads(w, (ctx) => sessionActivity(ctx, conv!));
    const titleCost = await reads(w, (ctx) => askClassifier(ctx, conv!, "title"));
    for (const cost of [pinCost, titleCost]) {
      expect(cost.filter((r) => r !== "get" && r !== "query team_memberships")).toEqual([]);
      expect(cost.length).toBeLessThanOrEqual(3);
    }
    // A team's pull request: its flag, one read.
    const pr = await w.t.run((ctx) => ctx.db.insert("pull_requests", {
      repository: "o/r", number: 1, github_pr_id: 1, title: "PR", body: "", state: "merged", author_github_username: "c", linked_session_ids: [carlConv], team_id: other, created_at: 1, updated_at: 1,
    } as any));
    const prRow = (await w.t.run((c) => c.db.get(pr)))!;
    expect(await reads(w, (ctx) => pullRequestClosed(ctx, prRow))).toEqual(["get"]);
    // The link writers: no priority, task or plan read.
    const plan = await w.t.run((ctx) => ctx.db.insert("plans", { user_id: carl, workspace: `team:${other}`, short_id: "pl-9", title: "P", status: "active", source: "human", created_at: 1, updated_at: 1 } as any));
    const planRow = (await w.t.run((c) => c.db.get(plan)))!;
    for (const link of [(ctx: any) => linkFromTask(ctx, conv!, { short_id: "ct-9" }), (ctx: any) => linkFromPlan(ctx, conv!, planRow)]) {
      const cost = await reads(w, link);
      expect(cost.filter((r) => r.startsWith("query ") && r !== "query team_memberships")).toEqual([]);
    }
    const p = await w.t.run((ctx) => ctx.db.insert("priorities", {
      user_id: carl, workspace: `team:${other}`, short_id: "pri-9", title: "x", summary: "", status: "active", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1,
    } as any));
    const linkCost = await reads(w, (ctx) => linkSession(ctx, conv!, p, undefined));
    expect(linkCost).toEqual(["get", "get"]);
    expect((await w.conversation(carlConv))?.priority_id).toBeUndefined();
  });
});

describe("crons", () => {
  test("no 3-hourly priority pass remains; the safety sweep runs once a day", () => {
    const entries = Object.entries((crons as any).crons) as Array<[string, { name: string; schedule: { type: string; cron?: string } }]>;
    expect(entries.some(([, c]) => c.schedule.cron === "0 */3 * * *")).toBe(false);
    expect(entries.filter(([, c]) => c.name.startsWith("priorityPassSweep")).map(([id, c]) => [id, c.schedule])).toEqual([["priority pass safety sweep", { cron: "50 10 * * *", type: "cron" }]]);
  });
});

describe("serves hint", () => {
  test("`cast state --serves` is stored on the pin event and shown to the pass as a hint for that session", async () => {
    const w = await world();
    const token = "cc_test_serves_ana";
    await w.t.run(async (ctx) => ctx.db.insert("api_tokens", { user_id: w.ana, token_hash: await hashToken(token), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any));
    const set = (serves: string) => w.t.mutation(api.conversations.setThreadState, { session: "jx7team", text: "Grader faults at 9%", status: "working", serves, api_token: token });
    await expect(set("in-5")).rejects.toThrow("is not a priority or milestone");
    await set("PRI-3/s2");
    await settle(w);
    const [event] = await w.t.run((ctx) => ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q) => q.eq("conversation_id", w.teamConv)).collect());
    expect(event.serves).toBe("pri-3/s2");

    setSystemTime(new Date(Date.now() + PASS_DEBOUNCE_MS));
    const read = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    const session = read.input.sessions.find((s: any) => s.id === "jx7team");
    expect(session.serves).toBe("pri-3/s2");
    expect(priorityPassRequest(read.input).req.prompt).toContain("Its agent says it serves pri-3/s2: a hint");
  });

  test("re-pinning the same words with the same --serves adds nothing and asks for nothing; a new --serves does", async () => {
    const w = await world();
    const t0 = Date.now();
    const events = () => w.t.run((ctx) => ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q) => q.eq("conversation_id", w.teamConv)).collect());
    await pinAt(w, w.teamConv, t0, "Grader faults at 9%", "working", "pri-3/s2");
    const requests = (await jobs(w, "priorityPassSchedule:request", "")).length;
    // Past the slack, so an ask would move the pending pass.
    await pinAt(w, w.teamConv, t0 + 5 * MIN, "Grader faults at 9%", "working", "pri-3/s2");
    expect((await events()).length).toBe(1);
    expect(await jobs(w, "priorityPassSchedule:request", "")).toHaveLength(requests);
    await pinAt(w, w.teamConv, t0 + 6 * MIN, "Grader faults at 9%", "working", "pri-3/s3");
    expect((await events()).map((e) => e.serves)).toEqual(["pri-3/s2", "pri-3/s3"]);
    expect((await scheduleOf(w, w.ana, w.team))!.due_at).toBe(t0 + 6 * MIN + PASS_DEBOUNCE_MS);
  });
});
