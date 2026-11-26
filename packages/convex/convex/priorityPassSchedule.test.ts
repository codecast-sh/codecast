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
import { PASS_DEBOUNCE_MS, PASS_MAX_WAIT_MS, PASS_MIN_GAP_MS } from "./lib/priorityPassSchedule";
import { PRIORITY_PASS_DAILY_USD } from "./priorityPassRun";
import { pass, stubModel, world } from "./priorityPassRun.testkit";

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
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: t0 - 20 * MIN, finished_at: t0 - 19 * MIN, status: "ok", cost_usd: 0.1, cursor_at: t0 - 25 * MIN, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await pinAt(w, w.teamConv, t0, "After the manual run");
    expect(await fireAt(w, t0 + PASS_DEBOUNCE_MS)).toBe("waiting");
    const [job] = await jobs(w, "priorityPassSchedule:fire");
    expect(Math.round(job.scheduledTime)).toBe(t0 - 20 * MIN + PASS_MIN_GAP_MS);
    // The list says when it will really run.
    const asAna = w.t.withIdentity({ subject: `${w.ana}|session` });
    expect((await asAna.query((api as any).priorities.list, { workspace: w.team })).next_pass_at).toBe(t0 - 20 * MIN + PASS_MIN_GAP_MS);
  });

  test("the daily cost ceiling fits a working day of passes at the gap", () => {
    // Twelve hours of activity at the gap, at the high end of an incremental pass's estimated cost ($0.12).
    expect(((12 * 60 * MIN) / PASS_MIN_GAP_MS) * 0.12).toBeLessThanOrEqual(PRIORITY_PASS_DAILY_USD);
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

  test("nothing is scheduled where the feature is off", async () => {
    const w = await world();
    await pinAt(w, w.otherConv, Date.now(), "Work in Other");
    expect(await scheduleOf(w, w.ana, `team:${w.other}`)).toBeNull();
    expect(await jobs(w, "priorityPassSchedule:fire")).toHaveLength(0);
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
});
