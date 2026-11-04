import { describe, expect, test } from "bun:test";
import { patchReplay, replayIndexFields, replayIndexStale } from "./replayIndex";
import { makeFakeDb } from "../testDb";

const H = 3_600_000;

describe("replay index fields", () => {
  test("the person key is the list's personKey, and the cut flag is set only when cut", () => {
    expect(replayIndexFields({ user: { email: " Ada@Example.com " } })).toEqual({ person_key: "ada@example.com", rest_cut: undefined });
    expect(replayIndexFields({ user: { id: "d1" }, captured_ms: 60_000, duration_ms: H })).toEqual({ person_key: "d1", rest_cut: true });
    // A shortfall inside the clocks' slack is not a cut.
    expect(replayIndexFields({ captured_ms: H - 30_000, duration_ms: H }).rest_cut).toBeUndefined();
    expect(replayIndexStale({ user: { id: "d1" } })).toBe(true);
    expect(replayIndexStale({ user: { id: "d1" }, person_key: "d1" })).toBe(false);
  });

  test("a patch that reads the rest in stamps the row and moves the source's tally once", async () => {
    const db = makeFakeDb({
      event_sources: [{ _id: "s1", replay_rest: { cut: 10, unknown: 0, at: 1 } }],
      replays: [{ _id: "r1", source_id: "s1", captured_ms: 60_000, duration_ms: H, rest_cut: true }],
    });
    const ctx = { db };
    const row = () => db._tables.replays[0];
    await patchReplay(ctx, row(), { captured_ms: H });
    expect(row().rest_cut).toBeUndefined();
    expect(db._tables.event_sources[0].replay_rest.cut).toBe(9);
    // Nothing crossed the line: the tally stays.
    await patchReplay(ctx, row(), { updated_at: 5 });
    expect(db._tables.event_sources[0].replay_rest.cut).toBe(9);
    // A longer vendor length cuts it again.
    await patchReplay(ctx, row(), { duration_ms: 3 * H });
    expect([row().rest_cut, db._tables.event_sources[0].replay_rest.cut]).toEqual([true, 10]);
  });

  test("a row the backfill has not stamped moves the tally by what it says, not by its flag", async () => {
    const db = makeFakeDb({
      event_sources: [{ _id: "s1", replay_rest: { cut: 3, unknown: 0, at: 1 } }],
      replays: [{ _id: "r1", source_id: "s1", captured_ms: 60_000, duration_ms: H }],
    });
    await patchReplay({ db }, db._tables.replays[0], { captured_ms: H });
    expect(db._tables.event_sources[0].replay_rest.cut).toBe(2);
  });
});
