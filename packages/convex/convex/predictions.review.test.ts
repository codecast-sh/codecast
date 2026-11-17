import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { predictionPatch, readDuePredictions, readPrediction } from "./predictions";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-17T00:00:00Z");
const WS = "team:teams_union";
const goal = (extra: Record<string, any> = {}) => ({
  _id: "initiatives_9", _creationTime: 1, user_id: "u", workspace: WS, short_id: "in-9", title: "g", status: "active", project_ids: [], health: "none", created_at: 1, updated_at: 1,
  metrics: [{ key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14" }], ...extra,
});
const watch = { _id: "metric_watches_14", _creationTime: 1, short_id: "mw-14", workspace: WS, name: "Intros", unit: "/week", points: [] as any[] };
const task = (n: number, extra: Record<string, any> = {}) => ({ _id: `tasks_${n}`, _creationTime: n, short_id: `ct-${n}`, user_id: "u", workspace: WS, title: `t${n}`, status: "open", ...extra });
const daily = (from: number, days: number, at: (i: number) => number) =>
  Array.from({ length: days }, (_, i) => { const v = at(i); return { _id: `metric_rollups_${from}_${i}`, _creationTime: 1, watch_id: watch._id, hour: from + i * DAY, n: 24, sum: v * 24, min: v, max: v }; });
const db = (t: Record<string, any[]> = {}) => makeFakeDb({ initiatives: [goal()], metric_watches: [watch], metric_points: [], metric_rollups: [], tasks: [], ...t }, { indexes: schemaIndexes(schema), strictPatch: true });
const ctxOf = (d: any) => ({ db: d } as any);
const predicted = (extra: Record<string, any> = {}) => ({ goal_ref: "in-9:intros_a_week", direction: "up", size: 5, relative: true, read_days: 14, basis: "b", set_at: NOW - 40 * DAY, series: "mw-14", due_at: NOW - HOUR, ...extra });

describe("review probes", () => {
  test("a prediction set AFTER ship, on a metric that already moved, reads held (hindsight is scored)", async () => {
    const SHIP = NOW - 20 * DAY;
    const rollups = [...daily(SHIP - 20 * DAY, 20, (i) => 30 + (i % 2)), ...daily(SHIP + HOUR, 19, (i) => 40 + (i % 2))];
    const d = db({ tasks: [task(1, { status: "done", closed_at: SHIP })], metric_rollups: rollups });
    const patch = await predictionPatch(ctxOf(d), { workspace: WS, short_id: "ct-1" }, "in-9:intros_a_week +20% in 14d :: saw the chart", NOW);
    await d.patch("tasks_1", patch);
    await readDuePredictions(ctxOf(d), NOW + 14 * DAY);
    expect((await d.get("tasks_1")).realised).toMatchObject({ verdict: "held" });
  });

  test("a task re-shipped after its read is never read again: the verdict stays on the first ship", async () => {
    const first = NOW - 30 * DAY;
    const realised = { verdict: "opposite", value_before: 1, value_after: 0, delta: -1, within_noise: false, band: 0, shipped_at: first, from: first, to: first + 14 * DAY, read_at: first + 14 * DAY, note: "" };
    const d = db({ tasks: [task(2, { status: "done", closed_at: NOW - 20 * DAY, predicted: predicted({ due_at: undefined }), realised })] });
    expect(await readDuePredictions(ctxOf(d), NOW)).toEqual({ read: 0, deferred: 0, more: false });
  });

  test("reopen via tasks.update keeps watch_from; a later re-close reads from the FIRST ship", async () => {
    const first = NOW - 40 * DAY, second = NOW - 15 * DAY;
    const d = db({ tasks: [task(3, { status: "done", watch_from: first, closed_at: second, predicted: predicted() })] });
    const out: any = await readPrediction(ctxOf(d), await d.get("tasks_3"), NOW);
    expect(out.realised.shipped_at).toBe(first);
  });

  test("one task that throws aborts the whole batch; with the same order next hour it throws again", async () => {
    const d = db({ tasks: [task(4, { status: "done", closed_at: NOW - 15 * DAY, predicted: predicted({ due_at: NOW - 2 * DAY }) }), task(5, { status: "open", predicted: predicted() })] });
    const ctx = ctxOf(d);
    const realQuery = d.query.bind(d);
    ctx.db = new Proxy(d, { get: (t: any, k) => k === "query" ? (name: string) => { if (name === "metric_rollups") throw new Error("Too many documents read"); return realQuery(name); } : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
    await expect(readDuePredictions(ctx, NOW)).rejects.toThrow("Too many");
    expect((await d.get("tasks_5")).predicted.due_at).toBe(NOW - HOUR);
  });

  test("relative % on a zero baseline through the sweep", async () => {
    const SHIP = NOW - 15 * DAY;
    const d = db({ tasks: [task(6, { status: "done", closed_at: SHIP, predicted: predicted() })], metric_rollups: [...daily(SHIP - 14 * DAY, 2, () => 0), ...daily(SHIP + HOUR, 2, () => 0.01)] });
    await readDuePredictions(ctxOf(d), NOW);
    expect((await d.get("tasks_6")).realised).toMatchObject({ verdict: "held", within_noise: null });
  });
});
