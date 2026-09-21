import { describe, expect, test } from "bun:test";
import { applyActivate, insertTask } from "./agentTasks";
import { makeFakeDb } from "./testDb";

// A routine created paused (org-hire.md H8): no run_at, nothing fires; one
// activation puts the first run one interval out, clears the install's
// temporary gate, and leaves a person's own precheck alone.

const ME = ("u".repeat(31) + "m") as any;
const db = () => makeFakeDb({ agent_tasks: [], counters: [], conversations: [] });
const ctx = (d: any) => ({ db: d }) as any;
const DAY = 86_400_000;

describe("paused create", () => {
  test("a recurring trigger created paused has no run_at and does not fire until activated", async () => {
    const d = db();
    const { id } = await insertTask(ctx(d), ME, { title: "Ads daily", prompt: "loader", schedule_type: "recurring", interval_ms: DAY, status: "paused" });
    const row = await d.get(id);
    expect(row).toMatchObject({ status: "paused", run_count: 0, interval_ms: DAY });
    expect(row.run_at).toBeUndefined();
    const before = Date.now();
    expect(await applyActivate(ctx(d), row)).toBe(true);
    const active = await d.get(id);
    expect(active.status).toBe("scheduled");
    expect(active.run_at).toBeGreaterThanOrEqual(before + DAY);
    expect(await applyActivate(ctx(d), active)).toBe(false);
  });
  test("activation clears the install gate but keeps a person's precheck; event triggers cannot be paused at birth", async () => {
    const d = db();
    const { id } = await insertTask(ctx(d), ME, { title: "Gated", prompt: "p", schedule_type: "recurring", interval_ms: DAY, status: "paused", precheck: "exit 1" });
    await applyActivate(ctx(d), await d.get(id));
    expect((await d.get(id)).precheck).toBeUndefined();
    const own = await insertTask(ctx(d), ME, { title: "Guarded", prompt: "p", schedule_type: "recurring", interval_ms: DAY, status: "paused", precheck: "test -f ready" });
    await applyActivate(ctx(d), await d.get(own.id));
    expect((await d.get(own.id)).precheck).toBe("test -f ready");
    await expect(insertTask(ctx(d), ME, { title: "E", prompt: "p", schedule_type: "event", event_filter: { event_type: "push" }, status: "paused" })).rejects.toThrow(/cannot be created paused/);
    const plain = await insertTask(ctx(d), ME, { title: "Plain", prompt: "p", schedule_type: "recurring", interval_ms: DAY });
    expect((await d.get(plain.id)).status).toBe("scheduled");
  });
});
