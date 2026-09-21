import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performRemoveDevices } from "./devices";

// Settings > Machines cleanup. The rule with teeth is the online refusal: the
// daemon heartbeat upserts its row every 30s, so deleting a live machine would
// undo itself and read as a removal that did not stick.
const ME = "u".repeat(31) + "m";
const OTHER = "u".repeat(31) + "o";
const DAY = 24 * 60 * 60 * 1000;

function fixtures() {
  const now = Date.now();
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: OTHER, name: "Other" }],
    devices: [
      { _id: "d1", user_id: ME, device_id: "live", label: "My-MacBook", platform: "darwin", last_seen: now },
      { _id: "d2", user_id: ME, device_id: "old1", label: "Old-MacBook", platform: "darwin", last_seen: now - 40 * DAY },
      { _id: "d3", user_id: ME, device_id: "old2", label: "Dead box", platform: "linux", is_remote: true, last_seen: now - 90 * DAY },
      // Same device_id under another account: a cloned disk. Never mine to remove.
      { _id: "d4", user_id: OTHER, device_id: "old1", label: "Theirs", platform: "darwin", last_seen: now - 40 * DAY },
    ],
  });
}

function ctxFor(db: any) {
  const scheduled: any[] = [];
  return { ctx: { db, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => void scheduled.push(args) } }, scheduled };
}

const ids = (db: any) => db._tables.devices.map((d: any) => d._id).sort();

describe("performRemoveDevices", () => {
  test("removes offline machines and schedules their capability cleanup", async () => {
    const db = fixtures();
    const { ctx, scheduled } = ctxFor(db);
    const res = await performRemoveDevices(ctx, ME as any, ["old1", "old2"]);
    expect(res).toEqual({ removed: ["old1", "old2"], skipped: [] });
    expect(ids(db)).toEqual(["d1", "d4"]);
    expect(scheduled).toEqual([
      { user_id: ME, device_id: "old1" },
      { user_id: ME, device_id: "old2" },
    ]);
  });

  test("refuses an online machine: its next heartbeat would list it again", async () => {
    const db = fixtures();
    const { ctx, scheduled } = ctxFor(db);
    const res = await performRemoveDevices(ctx, ME as any, ["live", "old1"]);
    expect(res).toEqual({ removed: ["old1"], skipped: [{ device_id: "live", reason: "online" }] });
    expect(ids(db)).toEqual(["d1", "d3", "d4"]);
    expect(scheduled).toHaveLength(1);
  });

  test("another account's machine with the same device id is untouched", async () => {
    const db = fixtures();
    const { ctx } = ctxFor(db);
    await performRemoveDevices(ctx, ME as any, ["old1"]);
    expect(db._tables.devices.find((d: any) => d._id === "d4")).toBeTruthy();
  });

  test("an unknown or repeated id is reported once, never thrown", async () => {
    const db = fixtures();
    const { ctx } = ctxFor(db);
    const res = await performRemoveDevices(ctx, ME as any, ["nope", "old1", "old1"]);
    expect(res).toEqual({ removed: ["old1"], skipped: [{ device_id: "nope", reason: "unknown" }] });
  });

  test("caps the batch", async () => {
    const db = fixtures();
    const { ctx } = ctxFor(db);
    const many = Array.from({ length: 101 }, (_, i) => `x${i}`);
    await expect(performRemoveDevices(ctx, ME as any, many)).rejects.toThrow(/at most 100/);
  });
});
