// A task's predicted effect on a goal metric (ct-96177): what a prediction
// may name, when the sweep reads it, what it reads from (a live series' rows
// or the goal's reports), the verdict, and how a goal lists them.
import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { leaseDuePredictions, predictionPatch, readOnePrediction } from "./predictions";
import { goalHitRate, goalPredictions } from "./lib/goalPredictions";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-17T00:00:00Z");
const WS = "team:teams_union";
const OTHER = "team:teams_other";
const ME = "users_me";

const goal = (extra: Record<string, any> = {}) => ({
  _id: "initiatives_9", _creationTime: 1, user_id: ME, workspace: WS, short_id: "in-9", title: "Cost per match", status: "active", project_ids: [], health: "none", created_at: 1, updated_at: 1,
  metrics: [
    { key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14" },
    { key: "dollars_per_intro", name: "Dollars per intro", target: "under $250" },
  ],
  score_history: { dollars_per_intro: [] as any[] },
  ...extra,
});
const watch = { _id: "metric_watches_14", _creationTime: 1, short_id: "mw-14", workspace: WS, name: "Intros a week", unit: "/week", points: [] as any[] };
const task = (n: number, extra: Record<string, any> = {}) => ({ _id: `tasks_${n}`, _creationTime: n, short_id: `ct-${n}`, user_id: ME, workspace: WS, title: `task ${n}`, status: "open", ...extra });

/** One rollup a day for `days` days from `from`, the value `at(i)` all day. */
const daily = (from: number, days: number, at: (i: number) => number) =>
  Array.from({ length: days }, (_, i) => { const v = at(i); return { _id: `metric_rollups_${from}_${i}`, _creationTime: 1, watch_id: watch._id, hour: from + i * DAY, n: 24, sum: v * 24, min: v, max: v }; });

function db(tables: Record<string, any[]> = {}) {
  return makeFakeDb({ initiatives: [goal()], metric_watches: [watch], metric_points: [], metric_rollups: [], tasks: [], ...tables }, { indexes: schemaIndexes(schema), strictPatch: true });
}
const ctxOf = (d: ReturnType<typeof makeFakeDb>) => ({ db: d } as any);
/** One sweep as the cron runs it: lease what is due, then read each in its own call. */
async function readDuePredictions(ctx: any, now: number) {
  const { ids, more } = await leaseDuePredictions(ctx, now);
  let read = 0, deferred = 0;
  for (const id of ids) {
    const outcome = await readOnePrediction(ctx, id, now);
    if (outcome && "realised" in outcome) read++;
    else if (outcome && "due_at" in outcome) deferred++;
  }
  return { read, deferred, more };
}
const row = async (d: any, id: string) => d.get(id);

describe("setting a prediction", () => {
  test("names a metric of a goal in the task's workspace, keeps its series, and is first due at its date", async () => {
    const patch = await predictionPatch(ctxOf(db()), { workspace: WS, short_id: "ct-1" }, "in-9:intros_a_week +5% by 2026-12-15 :: replay env +6", NOW);
    expect(patch.predicted).toMatchObject({ goal_ref: "in-9:intros_a_week", series: "mw-14", due_at: Date.parse("2026-12-16T00:00:00Z"), basis: "replay env +6" });
    expect("realised" in patch && patch.realised).toBeUndefined();
  });
  test("days after ship are first looked at that many days from now", async () => {
    const patch = await predictionPatch(ctxOf(db()), { workspace: WS, short_id: "ct-1" }, "in-9:dollars_per_intro -$40 in 21d :: sim", NOW);
    expect(patch.predicted).toMatchObject({ read_days: 21, due_at: NOW + 21 * DAY });
    expect(patch.predicted!.series).toBeUndefined();
  });
  test("an empty line clears it and its reading", async () => {
    expect(await predictionPatch(ctxOf(db()), { workspace: WS, short_id: "ct-1" }, "", NOW)).toEqual({ predicted: undefined, realised: undefined });
  });
  test.each([
    ["in-8:intros_a_week +5% in 7d :: x", "No goal in-8"],
    ["in-9:weekly_users +5% in 7d :: x", 'has no metric "weekly_users"'],
    ["in-9:intros_a_week +5%", "A prediction reads"],
  ])("refuses %p", async (line, words) => {
    await expect(predictionPatch(ctxOf(db()), { workspace: WS, short_id: "ct-1" }, line, NOW)).rejects.toThrow(words);
  });
  test("refuses a prediction on a task that already shipped, which would be scored on what it already saw", async () => {
    await expect(predictionPatch(ctxOf(db()), { workspace: WS, short_id: "ct-1", status: "done", closed_at: NOW - DAY }, "in-9:intros_a_week +5% in 7d :: x", NOW)).rejects.toThrow("ct-1 shipped 2026-11-16");
    const reopened = await predictionPatch(ctxOf(db()), { workspace: WS, short_id: "ct-1", status: "open", closed_at: undefined }, "in-9:intros_a_week +5% in 7d :: x", NOW);
    expect(reopened.predicted?.goal_ref).toBe("in-9:intros_a_week");
  });
  test("refuses another workspace's goal", async () => {
    await expect(predictionPatch(ctxOf(db()), { workspace: OTHER, short_id: "ct-1" }, "in-9:intros_a_week +5% in 7d :: x", NOW)).rejects.toThrow("No goal in-9");
  });
});

const predicted = (extra: Record<string, any> = {}) => ({ goal_ref: "in-9:intros_a_week", direction: "up", size: 5, relative: true, read_days: 14, basis: "replay", set_at: NOW - 40 * DAY, series: "mw-14", due_at: NOW - HOUR, ...extra });
const SHIP = NOW - 15 * DAY;

describe("the read", () => {
  test("a shipped task is read at its time from the series' rollups: 30 before, 40 after, held", async () => {
    const d = db({
      tasks: [task(1, { status: "done", closed_at: SHIP, predicted: predicted() })],
      metric_rollups: [...daily(SHIP - 20 * DAY, 20, (i) => 30 + (i % 2 ? 1 : -1)), ...daily(SHIP + HOUR, 15, (i) => 40 + (i % 2 ? 1 : -1))],
    });
    expect(await readDuePredictions(ctxOf(d), NOW)).toEqual({ read: 1, deferred: 0, more: false });
    const t = await row(d, "tasks_1");
    expect(t.realised).toMatchObject({ verdict: "held", shipped_at: SHIP, from: SHIP, to: SHIP + 14 * DAY, source: "mw-14", within_noise: false, read_at: NOW });
    expect(t.realised.value_before).toBeCloseTo(30, 0);
    expect(t.realised.value_after).toBeCloseTo(40, 0);
    // Revisited in a week in case the task is reopened and shipped again.
    expect(t.predicted.due_at).toBe(NOW + 7 * DAY);
    expect(t.updated_at).toBe(NOW);
    // Read once: nothing is due before the revisit.
    expect(await readDuePredictions(ctxOf(d), NOW + DAY)).toEqual({ read: 0, deferred: 0, more: false });
  });

  test("a short window reads the raw metric_points; the ship is when the task closed, not a stale watch start", async () => {
    const watchFrom = NOW - 4 * DAY;
    const points = [-3, -2.5, -2, -1.5, -1, 0.5, 1, 1.5, 2, 2.5].map((dd, i) => ({ _id: `metric_points_${i}`, _creationTime: 1, watch_id: watch._id, at: watchFrom + dd * DAY, value: dd < 0 ? 50 + (i % 2) : 20 + (i % 2) }));
    const d = db({ tasks: [task(2, { status: "done", closed_at: watchFrom, watch_from: watchFrom - 30 * DAY, predicted: predicted({ read_days: 3 }) })], metric_points: points });
    await readDuePredictions(ctxOf(d), NOW);
    const t = await row(d, "tasks_2");
    expect(t.realised).toMatchObject({ verdict: "opposite", shipped_at: watchFrom, to: watchFrom + 3 * DAY });
    expect(t.realised.value_before).toBeCloseTo(50.4, 1);
  });

  test("a move inside the series' own swing is not shown", async () => {
    const d = db({
      tasks: [task(3, { status: "done", closed_at: SHIP, predicted: predicted() })],
      metric_rollups: [...daily(SHIP - 14 * DAY, 14, (i) => (i % 2 ? 20 : 40)), ...daily(SHIP + HOUR, 14, (i) => (i % 2 ? 22 : 40))],
    });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_3")).realised).toMatchObject({ verdict: "not_shown", within_noise: true });
  });

  test("a goal's reported values are read when its metric has no series", async () => {
    const history = [-10, -8, -6, -4, -2, 2, 4, 6, 8, 10].map((dd) => ({ value: dd < 0 ? "$600" : "$450", observed_at: SHIP + dd * DAY, source: "report" }));
    const d = db({ initiatives: [goal({ score_history: { dollars_per_intro: history } })], tasks: [task(4, { status: "done", closed_at: SHIP, predicted: predicted({ goal_ref: "in-9:dollars_per_intro", direction: "down", size: 40, relative: false, series: undefined }) })] });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_4")).realised).toMatchObject({ verdict: "held", value_before: 600, value_after: 450, delta: -150, source: "in-9 reports" });
  });

  test("a task not shipped yet is looked at again in a day, and never read early", async () => {
    const d = db({ tasks: [task(5, { status: "in_progress", predicted: predicted() }), task(6, { status: "done", closed_at: NOW - 2 * DAY, predicted: predicted() })] });
    expect(await readDuePredictions(ctxOf(d), NOW)).toEqual({ read: 0, deferred: 2, more: false });
    expect((await row(d, "tasks_5")).predicted.due_at).toBe(NOW + DAY);
    // Shipped two days ago and read 14 days after ship.
    expect((await row(d, "tasks_6")).predicted.due_at).toBe(NOW + 12 * DAY);
    expect((await row(d, "tasks_6")).realised).toBeUndefined();
  });

  test("a task reopened after ship waits again instead of reading the abandoned ship", async () => {
    const d = db({ tasks: [task(7, { status: "open", closed_at: SHIP, watch_from: SHIP, predicted: predicted() })] });
    await readDuePredictions(ctxOf(d), NOW);
    const t = await row(d, "tasks_7");
    expect(t.realised).toBeUndefined();
    expect(t.predicted.due_at).toBe(NOW + DAY);
  });

  test("a read date that falls before ship waits three days after ship", async () => {
    const shipped = NOW - DAY;
    const d = db({ tasks: [task(8, { status: "done", closed_at: shipped, predicted: predicted({ read_days: undefined, read_at: NOW - 2 * DAY }) })] });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_8")).predicted.due_at).toBe(shipped + 3 * DAY);
  });

  test("a dropped task, and one that never ships, read as unreadable", async () => {
    const d = db({ tasks: [task(9, { status: "dropped", predicted: predicted() }), task(10, { status: "open", predicted: predicted({ set_at: NOW - 200 * DAY }) })] });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_9")).realised).toMatchObject({ verdict: "unreadable", note: "The task was dropped" });
    expect((await row(d, "tasks_10")).realised).toMatchObject({ verdict: "unreadable", note: expect.stringContaining("had not shipped 180 days") });
  });

  test("a series that starts after ship has no reading before it: unreadable, not a guess", async () => {
    const d = db({ tasks: [task(11, { status: "done", closed_at: SHIP, predicted: predicted() })], metric_rollups: daily(SHIP + HOUR, 14, () => 40) });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_11")).realised).toMatchObject({ verdict: "unreadable", note: "The metric has no reading before ship", shipped_at: SHIP });
  });

  test("a renamed metric still reads through the series it named; a gone one without a series is unreadable", async () => {
    const renamed = goal({ metrics: [{ key: "introductions_weekly", name: "Introductions weekly", target: "at least 60", series: "mw-14" }] });
    const d = db({
      initiatives: [renamed],
      tasks: [task(12, { status: "done", closed_at: SHIP, predicted: predicted() }), task(13, { status: "done", closed_at: SHIP, predicted: predicted({ goal_ref: "in-9:dollars_per_intro", series: undefined }) })],
      metric_rollups: [...daily(SHIP - 14 * DAY, 14, () => 30), ...daily(SHIP + HOUR, 14, () => 40)],
    });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_12")).realised).toMatchObject({ verdict: "held", source: "mw-14" });
    expect((await row(d, "tasks_13")).realised).toMatchObject({ verdict: "unreadable", note: "in-9 no longer has the metric dollars_per_intro" });
  });

  test("a task reopened after its read and shipped again is read again on the new ship", async () => {
    const d = db({
      tasks: [task(15, { status: "done", closed_at: SHIP, predicted: predicted() })],
      metric_rollups: [...daily(SHIP - 14 * DAY, 14, () => 30), ...daily(SHIP + HOUR, 14, () => 40), ...daily(SHIP + 15 * DAY, 30, () => 25)],
    });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_15")).realised.verdict).toBe("held");
    // Reopened, then shipped again: the next revisit drops the old reading and waits for the new read time.
    const reship = NOW + 2 * DAY;
    await d.patch("tasks_15", { status: "done", closed_at: reship });
    expect(await readDuePredictions(ctxOf(d), NOW + 7 * DAY)).toEqual({ read: 0, deferred: 1, more: false });
    const t = await row(d, "tasks_15");
    expect(t.realised).toBeUndefined();
    expect(t.predicted.due_at).toBe(reship + 14 * DAY);
    await readDuePredictions(ctxOf(d), reship + 14 * DAY);
    expect((await row(d, "tasks_15")).realised).toMatchObject({ shipped_at: reship, verdict: "opposite" });
  });

  test("revisits stop two months after the read", async () => {
    const d = db({ tasks: [task(16, { status: "done", closed_at: SHIP, predicted: predicted({ due_at: NOW }), realised: { verdict: "held", value_before: 1, value_after: 2, delta: 1, within_noise: false, band: 0.1, shipped_at: SHIP, from: SHIP, to: SHIP, read_at: NOW - 61 * DAY, note: "" } })] });
    await readDuePredictions(ctxOf(d), NOW);
    const t = await row(d, "tasks_16");
    expect(t.predicted.due_at).toBeUndefined();
    expect(t.realised.verdict).toBe("held");
  });

  test("the sweep leases what it takes an hour ahead, so a read that fails is retried next hour and the next pass takes others", async () => {
    const d = db({ tasks: [task(17, { status: "in_progress", predicted: predicted() }), task(18, { status: "in_progress", predicted: predicted() })] });
    const { ids } = await leaseDuePredictions(ctxOf(d), NOW);
    expect(ids).toEqual(["tasks_17", "tasks_18"] as any);
    expect((await row(d, "tasks_17")).predicted.due_at).toBe(NOW + HOUR);
    expect((await leaseDuePredictions(ctxOf(d), NOW + 1)).ids).toEqual([]);
    // tasks_17's read never ran (it failed); tasks_18's did. Next hour only tasks_17 is due again.
    await readOnePrediction(ctxOf(d), "tasks_18" as any, NOW);
    expect((await leaseDuePredictions(ctxOf(d), NOW + HOUR)).ids).toEqual(["tasks_17"] as any);
  });

  test("a series moved to another workspace is not read", async () => {
    const d = db({ metric_watches: [{ ...watch, workspace: OTHER }], tasks: [task(14, { status: "done", closed_at: SHIP, predicted: predicted() })], metric_rollups: [...daily(SHIP - 14 * DAY, 14, () => 30), ...daily(SHIP + HOUR, 14, () => 40)] });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await row(d, "tasks_14")).realised).toMatchObject({ verdict: "unreadable", note: expect.stringContaining("no live series or reported values") });
  });
});

describe("a goal's predictions", () => {
  const read = (verdict: string, at: number) => ({ verdict, value_before: 30, value_after: 40, delta: 10, within_noise: false, band: 2, shipped_at: 1, from: 1, to: 2, read_at: at, note: "" });
  test("lists its own workspace's tasks, latest first, with the metric's unit and a hit rate", async () => {
    const d = db({
      tasks: [
        task(1, { predicted: predicted({ due_at: NOW + DAY }) }),
        task(2, { status: "done", predicted: predicted({ due_at: undefined }), realised: read("held", NOW - DAY) }),
        task(3, { status: "done", predicted: predicted({ due_at: undefined }), realised: read("opposite", NOW - 2 * DAY) }),
        task(4, { workspace: OTHER, predicted: predicted() }),
        task(5, { predicted: predicted({ goal_ref: "in-90:intros_a_week" }) }),
        task(6, {}),
      ],
    });
    const { rows, tally } = await goalPredictions(ctxOf(d), goal() as any);
    expect(rows.map((r) => r.short_id)).toEqual(["ct-2", "ct-3", "ct-1"]);
    expect(rows[0]).toMatchObject({ unit: "/week", realised: { verdict: "held" } });
    expect("due_at" in rows[2].predicted).toBe(false);
    expect(tally).toEqual({ open: 1, held: 1, not_shown: 0, opposite: 1, unreadable: 0 });
    expect(await goalHitRate(ctxOf(d), { short_id: "in-9", workspace: WS })).toBe("1 of 2 predictions held (1 opposite), 1 open");
    expect(await goalHitRate(ctxOf(d), { short_id: "in-9", workspace: OTHER })).toBe("1 open");
  });
});
