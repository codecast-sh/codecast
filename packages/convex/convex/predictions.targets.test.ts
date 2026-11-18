// Where a predicted effect is read (ct-96177 follow-up): a goal metric, a
// metric series or an environment; whether the place can detect the predicted
// move, recorded when it is set; and how each kind is read after ship.
import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { backfillGoal, leaseDuePredictions, predictionPatch, readOnePrediction } from "./predictions";
import { targetSense } from "./lib/predictionTargets";
import { goalPredictions } from "./lib/goalPredictions";
import { compactCases } from "@codecast/shared/contracts/envs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-17T00:00:00Z");
const WS = "team:teams_union";
const ME = "users_me";
const ENV = "union/second-side-replay";

// 37 intros a week, read live with a Poisson model; dollars per intro has none.
const weekly = Array.from({ length: 8 }, (_, i) => ({ at: NOW - (7 - i) * 7 * DAY, value: 37 }));
const goal = {
  _id: "initiatives_9", _creationTime: 1, user_id: ME, workspace: WS, short_id: "in-9", title: "Cost per match", status: "active", project_ids: ["projects_funnel"], health: "none", created_at: 1, updated_at: 1,
  metrics: [
    { key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14", noise: "poisson" },
    { key: "dollars_per_intro", name: "Dollars per intro", target: "under $250" },
  ],
  envs: [{ env: ENV, level: "L2" }],
};
// The stage the goal decomposes into: need to matched, a rate out of about 400 needs a week.
const project = { _id: "projects_funnel", _creationTime: 1, user_id: ME, workspace: WS, short_id: "pj-f", title: "Funnel", status: "active", metrics: [{ key: "need_to_matched", name: "Need to matched", target: "at least 25%", series: "mw-17", window: "4w", noise: "binomial:400" }] };
const watch = (n: number, name: string, unit: string, points: any[]) => ({ _id: `metric_watches_${n}`, _creationTime: 1, short_id: `mw-${n}`, workspace: WS, name, unit, points });
const watches = [watch(14, "Intros a week", "/week", weekly), watch(17, "Need to matched", "%", Array.from({ length: 6 }, (_, i) => ({ at: NOW - (5 - i) * 7 * DAY, value: 15 })))];
const attempt = (n: number, at: number, mean: number, extra: Record<string, any> = {}) => ({ _id: `env_attempts_${n}`, _creationTime: n, workspace: WS, short_id: `ea-${n}`, env: ENV, env_version: "v1", level: "L2", candidate: { label: "base" }, split: "dev", n: 4, mean, started_at: at - HOUR, finished_at: at, by_user: ME, created_at: at, ...extra });
const cases = (n: number, scores: number[]) => ({ _id: `env_attempt_cases_${n}`, _creationTime: n, attempt_id: `env_attempts_${n}`, workspace: WS, cases: JSON.stringify(compactCases(scores.map((score, i) => ({ id: `c${i}`, score })))) });
const task = (n: number, extra: Record<string, any> = {}) => ({ _id: `tasks_${n}`, _creationTime: n, short_id: `ct-${n}`, user_id: ME, workspace: WS, title: `task ${n}`, status: "open", ...extra });

function db(tables: Record<string, any[]> = {}) {
  return makeFakeDb({ initiatives: [goal], projects: [project], metric_watches: watches, metric_points: [], metric_rollups: [], env_attempts: [], env_attempt_cases: [], tasks: [], ...tables }, { indexes: schemaIndexes(schema), strictPatch: true });
}
const ctxOf = (d: any) => ({ db: d } as any);
const open = { workspace: WS, short_id: "ct-1", status: "open" as const };

describe("what a place can detect", () => {
  test("a goal metric with a noise model: 37 intros a week detect about ±35% over four weeks a side, so +3% is unreadable", async () => {
    const sense = await targetSense(ctxOf(db()), WS, "in-9:intros_a_week", 28 * DAY);
    expect(sense).toMatchObject({ kind: "metric", goal: "in-9", series: "mw-14", level: 37 });
    expect((sense as any).mde).toBeCloseTo(0.35, 1);
    const small = await predictionPatch(ctxOf(db()), open, "in-9:intros_a_week +3% :: 12 of 33 declines", NOW);
    expect(small.predicted).toMatchObject({ goal: "in-9", readable: false, read_days: 28 });
    const large = await predictionPatch(ctxOf(db()), open, "in-9:intros_a_week +50% :: a new channel", NOW);
    expect(large.predicted).toMatchObject({ readable: true });
  });

  test("a metric with no noise model claims nothing", async () => {
    const p = await predictionPatch(ctxOf(db()), open, "in-9:dollars_per_intro -2% :: wasted pitches", NOW);
    expect(p.predicted!.readable).toBeUndefined();
    expect(p.predicted!.mde).toBeUndefined();
  });

  test("a stage series reads the noise model of the project metric that names it and serves the goal carrying that project", async () => {
    const sense = await targetSense(ctxOf(db()), WS, "mw-17", 28 * DAY);
    expect(sense).toMatchObject({ kind: "series", goal: "in-9", series: "mw-17", level: 15, name: "Need to matched" });
    const p = await predictionPatch(ctxOf(db()), open, "mw-17 +5pt in 28d :: geography gate", NOW);
    expect(p.predicted).toMatchObject({ goal_ref: "mw-17", goal: "in-9", series: "mw-17", readable: true });
    expect(p.predicted!.mde!).toBeLessThan(5 / 15);
  });

  test("an env detects from its attempts' paired interval and serves the goal that lists it", async () => {
    const d = db({ env_attempts: [attempt(1, NOW - DAY, 0.7, { paired_ci95: [-0.01, 0.01] })] });
    const p = await predictionPatch(ctxOf(d), open, `env:${ENV} +0.02 :: pitch rewrite`, NOW);
    expect(p.predicted).toMatchObject({ goal: "in-9", readable: true });
    expect(p.predicted!.read_days).toBeUndefined();
    expect((await predictionPatch(ctxOf(d), open, `env:${ENV} +0.005 :: tweak`, NOW)).predicted!.readable).toBe(false);
  });

  test("a series with no noise model takes its own week-to-week spread as one", async () => {
    const history = [60, 62, 58, 61, 59, 60, 63, 57].map((value, i) => ({ _id: `metric_points_${i}`, _creationTime: 1, watch_id: "metric_watches_18", at: NOW - i * 7 * DAY, value }));
    const d = db({ metric_watches: [...watches, watch(18, "Matched to opted in", "%", [{ at: NOW, value: 60 }])], metric_points: history });
    const sense = await targetSense(ctxOf(d), WS, "mw-18", 28 * DAY);
    // sd 2.0 on a level of 60 over 8 weekly periods a side: about ±6.6%.
    expect((sense as any).mde).toBeCloseTo((1.959963984540054 + 0.8416212335729143) * 2 * 2.0 / (Math.sqrt(8) * 60), 2);
    expect((await predictionPatch(ctxOf(d), open, "mw-18 +5pt :: slots held", NOW)).predicted).toMatchObject({ readable: true });
    expect((await predictionPatch(ctxOf(d), open, "mw-18 +1pt :: slots held", NOW)).predicted).toMatchObject({ readable: false });
  });

  test("a place the workspace does not have is refused; a series or env with no goal falls back to the goal the task is grounded on", async () => {
    await expect(predictionPatch(ctxOf(db()), open, "mw-99 +5pt :: x", NOW)).rejects.toThrow("No metric watch mw-99");
    await expect(predictionPatch(ctxOf(db()), open, "env:union/nothing +0.02 :: x", NOW)).rejects.toThrow("No environment union/nothing");
    const lone = db({ metric_watches: [...watches, watch(30, "Lone", "", [{ at: NOW, value: 3 }])] });
    const p = await predictionPatch(ctxOf(lone), { ...open, goal_ref: "in-9:intros_a_week" }, "mw-30 +1 :: x", NOW);
    expect(p.predicted).toMatchObject({ goal: "in-9" });
    expect(p.predicted!.readable).toBeUndefined();
  });
});

const SHIP = NOW - 15 * DAY;
async function sweep(d: any, now: number) {
  const { ids } = await leaseDuePredictions(ctxOf(d), now);
  for (const id of ids) await readOnePrediction(ctxOf(d), id, now);
}

describe("reading each kind after ship", () => {
  test("an env is read at its first attempt after ship, paired over the cases both scored", async () => {
    const p = { goal_ref: `env:${ENV}`, goal: "in-9", direction: "up", size: 0.02, relative: false, basis: "b", set_at: SHIP - 5 * DAY, readable: true, mde: 0.01, due_at: SHIP };
    const d = db({
      env_attempts: [attempt(1, SHIP - 2 * DAY, 0.7), attempt(2, SHIP + 3 * DAY, 0.75)],
      env_attempt_cases: [cases(1, [0.6, 0.7, 0.7, 0.8]), cases(2, [0.65, 0.75, 0.75, 0.85])],
      tasks: [task(1, { status: "done", closed_at: SHIP, predicted: p })],
    });
    await sweep(d, NOW);
    expect((await d.get("tasks_1")).realised).toMatchObject({ verdict: "held", value_before: 0.7, value_after: 0.75, delta: 0.05, source: `env:${ENV} ea-1→ea-2` });
  });

  test("an env with no attempt since ship waits for one", async () => {
    const p = { goal_ref: `env:${ENV}`, goal: "in-9", direction: "up", size: 0.02, relative: false, basis: "b", set_at: SHIP - 5 * DAY, due_at: SHIP };
    const d = db({ env_attempts: [attempt(1, SHIP - 2 * DAY, 0.7)], tasks: [task(2, { status: "done", closed_at: SHIP, predicted: p })] });
    await sweep(d, NOW);
    const t = await d.get("tasks_2");
    expect(t.realised).toBeUndefined();
    expect(t.predicted.due_at).toBe(NOW + DAY);
  });

  test("a prediction smaller than its place detects is read and kept, and judged unreadable whatever it did", async () => {
    const p = { goal_ref: `env:${ENV}`, goal: "in-9", direction: "up", size: 0.005, relative: false, basis: "b", set_at: SHIP - 5 * DAY, readable: false, mde: 0.03, due_at: SHIP };
    const d = db({ env_attempts: [attempt(1, SHIP - 2 * DAY, 0.7), attempt(2, SHIP + 3 * DAY, 0.75)], tasks: [task(3, { status: "done", closed_at: SHIP, predicted: p })] });
    await sweep(d, NOW);
    const r = (await d.get("tasks_3")).realised;
    expect(r).toMatchObject({ verdict: "unreadable", value_before: 0.7, value_after: 0.75 });
    expect(r.note).toStartWith("Unreadable at this environment (detects ±0.030)");
  });

  test("a series is read over the windows around ship, in the series' own values", async () => {
    const rollups = (from: number, days: number, v: number) => Array.from({ length: days }, (_, i) => ({ _id: `metric_rollups_${from}_${i}`, _creationTime: 1, watch_id: "metric_watches_17", hour: from + i * DAY, n: 24, sum: v * 24, min: v, max: v }));
    const p = { goal_ref: "mw-17", goal: "in-9", series: "mw-17", direction: "up", size: 3, relative: false, read_days: 14, basis: "b", set_at: SHIP - 5 * DAY, due_at: NOW - HOUR };
    const d = db({ metric_rollups: [...rollups(SHIP - 14 * DAY, 14, 15), ...rollups(SHIP + HOUR, 14, 20)], tasks: [task(4, { status: "done", closed_at: SHIP, predicted: p })] });
    await sweep(d, NOW);
    const r = (await d.get("tasks_4")).realised;
    // Judged against the binomial band of the project metric naming the series.
    expect(r).toMatchObject({ verdict: "held", value_before: 15, source: "mw-17", within_noise: false });
    expect(r.value_after).toBeCloseTo(20, 0);
    expect(r.band).toBeGreaterThan(0);
  });
});

describe("the goal's list", () => {
  test("lists every prediction serving the goal, a series in its unit; the backfill names the goal of older ones", async () => {
    const d = db({
      tasks: [
        task(1, { predicted: { goal_ref: "mw-17", goal: "in-9", series: "mw-17", direction: "up", size: 5, relative: false, read_days: 28, basis: "b", set_at: NOW, readable: true, mde: 0.2, due_at: NOW + DAY } }),
        task(2, { predicted: { goal_ref: "in-9:intros_a_week", direction: "up", size: 3, relative: true, read_days: 28, basis: "b", set_at: NOW - 1, due_at: NOW + DAY } }),
      ],
    });
    expect((await goalPredictions(ctxOf(d), goal as any)).rows.map((r) => r.short_id)).toEqual(["ct-1"]);
    expect(await (backfillGoal as any)._handler(ctxOf(d), {})).toEqual({ fixed: 1 });
    const { rows } = await goalPredictions(ctxOf(d), goal as any);
    expect(rows.map((r) => r.short_id)).toEqual(["ct-1", "ct-2"]);
    expect(rows[0]).toMatchObject({ unit: "%", said: "mw-17 +5 in 28d after ship" });
  });
});
