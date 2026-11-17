import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { leaseDuePredictions, readOnePrediction, readPrediction } from "./predictions";
import { judgePrediction, parsePrediction } from "@codecast/shared/contracts/predictedEffect";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-17T00:00:00Z");
const WS = "team:teams_union";
const goal = { _id: "initiatives_9", _creationTime: 1, user_id: "u", workspace: WS, short_id: "in-9", title: "g", status: "active", project_ids: [], health: "none", created_at: 1, updated_at: 1, metrics: [{ key: "intros_a_week", name: "Intros", target: "at least 60", series: "mw-14" }] };
const watch = { _id: "metric_watches_14", _creationTime: 1, short_id: "mw-14", workspace: WS, name: "Intros", unit: "/week", points: [] as any[] };
const db = (t: Record<string, any[]>) => makeFakeDb({ initiatives: [goal], metric_watches: [watch], metric_points: [], metric_rollups: [], tasks: [], ...t }, { indexes: schemaIndexes(schema), strictPatch: true });
const predicted = (x: Record<string, any> = {}) => ({ goal_ref: "in-9:intros_a_week", direction: "up", size: 5, relative: true, read_days: 14, basis: "b", set_at: NOW - 60 * DAY, series: "mw-14", due_at: NOW - HOUR, ...x });
const SHIP = NOW - 30 * DAY;
const read = { verdict: "held", value_before: 30, value_after: 40, delta: 10, within_noise: false, band: 2, shipped_at: SHIP, from: SHIP, to: SHIP + 14 * DAY, read_at: NOW - 16 * DAY, note: "" };

describe("re-review probes", () => {
  test("a done->done re-stamp of closed_at (tasks.update sets closed_at=now whenever status:'done' is passed) wipes a standing reading", async () => {
    const d = db({ tasks: [{ _id: "tasks_1", _creationTime: 1, short_id: "ct-1", user_id: "u", workspace: WS, title: "t", status: "done", closed_at: NOW - 2 * DAY, predicted: predicted(), realised: read }] });
    const out: any = await readOnePrediction({ db: d } as any, "tasks_1" as any, NOW);
    expect(out).toMatchObject({ clear: true });
    expect((await d.get("tasks_1")).realised).toBeUndefined();
  });
  test("lease moves due_at off the due range; a second lease in the same hour takes nothing", async () => {
    const d = db({ tasks: [{ _id: "tasks_2", _creationTime: 1, short_id: "ct-2", user_id: "u", workspace: WS, title: "t", status: "open", predicted: predicted() }] });
    expect((await leaseDuePredictions({ db: d } as any, NOW)).ids.length).toBe(1);
    expect((await leaseDuePredictions({ db: d } as any, NOW + HOUR - 1)).ids.length).toBe(0);
  });
  test("a dropped reading (shipped_at null) stops for good: reopened and shipped later, never read", async () => {
    const dropped = { ...read, verdict: "unreadable", shipped_at: null, value_before: null, value_after: null, delta: null, band: null, within_noise: null };
    const d = db({ tasks: [{ _id: "tasks_3", _creationTime: 1, short_id: "ct-3", user_id: "u", workspace: WS, title: "t", status: "done", closed_at: NOW - 20 * DAY, predicted: predicted(), realised: dropped }] });
    expect(await readPrediction({ db: d } as any, await d.get("tasks_3"), NOW)).toEqual({ stop: true });
  });
  test("% on a near-zero (not zero) baseline with no band: any tiny move holds", () => {
    expect(judgePrediction({ direction: "up", size: 5, relative: true }, { before: [{ at: 0, value: 1e-6 }], after: [{ at: 1, value: 2e-6 }] }).verdict).toBe("held");
  });
  test("dates: impossible refused, 'by D' reads at end of D", () => {
    expect("error" in parsePrediction("in-9:k +5% by 2027-02-30 :: x", NOW)).toBe(true);
    const r: any = parsePrediction("in-9:k +5% by 2026-11-17 :: x", NOW + HOUR);
    expect(new Date(r.prediction.read_at).toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });
});
