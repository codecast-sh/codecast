import { describe, expect, it } from "bun:test";
import {
  MAX_COLD_WARM_PER_PASS,
  MAX_DEEPEN_PER_PASS,
  WARM_DEEP_RANKS,
  WARM_DEEP_ROWS,
  WARM_TAIL_ROWS,
  planWarm,
  warmDepthForRank,
  type WarmRow,
} from "../inboxWarm";

function row(id: string, over: Partial<WarmRow> = {}): WarmRow {
  return {
    id,
    serverCount: 500,
    storedCount: 0,
    hasMoreAbove: false,
    newestTs: null,
    syncedCount: undefined,
    inFlight: false,
    ...over,
  };
}

describe("planWarm", () => {
  it("warms the top of the rendered list to the deep window and the rest to the tail", () => {
    const rows = Array.from({ length: WARM_DEEP_RANKS + 5 }, (_, i) => row(`c${i}`));
    const actions = planWarm(rows);
    expect(actions[0]).toEqual({ kind: "cold", id: "c0", rows: WARM_DEEP_ROWS, serverCount: 500 });
    expect(actions[WARM_DEEP_RANKS - 1]).toMatchObject({ kind: "cold", rows: WARM_DEEP_ROWS });
    expect(actions[WARM_DEEP_RANKS]).toMatchObject({ kind: "cold", id: `c${WARM_DEEP_RANKS}`, rows: WARM_TAIL_ROWS });
    expect(warmDepthForRank(0)).toBe(WARM_DEEP_ROWS);
    expect(warmDepthForRank(WARM_DEEP_RANKS)).toBe(WARM_TAIL_ROWS);
  });

  it("bounds cold warms per pass in on-screen order", () => {
    const rows = Array.from({ length: MAX_COLD_WARM_PER_PASS + 20 }, (_, i) => row(`c${i}`));
    const actions = planWarm(rows);
    expect(actions.length).toBe(MAX_COLD_WARM_PER_PASS);
    expect(actions[actions.length - 1].id).toBe(`c${MAX_COLD_WARM_PER_PASS - 1}`);
  });

  it("deepens a shallow tail inside the deep tier only when older rows exist", () => {
    const shallow = row("top", { storedCount: WARM_TAIL_ROWS, hasMoreAbove: true, newestTs: 10, syncedCount: 500 });
    const complete = row("done", { storedCount: 30, hasMoreAbove: false, newestTs: 10, syncedCount: 500 });
    expect(planWarm([shallow, complete])).toEqual([
      { kind: "deepen", id: "top", rows: WARM_DEEP_ROWS - WARM_TAIL_ROWS },
    ]);
  });

  it("does not deepen a row below the deep tier that already holds its tail", () => {
    const rows = Array.from({ length: WARM_DEEP_RANKS }, (_, i) =>
      row(`c${i}`, { storedCount: WARM_DEEP_ROWS, newestTs: 10, syncedCount: 500 }));
    rows.push(row("low", { storedCount: WARM_TAIL_ROWS, hasMoreAbove: true, newestTs: 10, syncedCount: 500 }));
    expect(planWarm(rows)).toEqual([]);
  });

  it("bounds deepens per pass", () => {
    const rows = Array.from({ length: MAX_DEEPEN_PER_PASS + 5 }, (_, i) =>
      row(`c${i}`, { storedCount: 10, hasMoreAbove: true, newestTs: 10, syncedCount: 500 }));
    expect(planWarm(rows).length).toBe(MAX_DEEPEN_PER_PASS);
  });

  it("fetches the delta only once message_count grows past the synced mark", () => {
    const caught = row("a", { storedCount: WARM_DEEP_ROWS, newestTs: 10, syncedCount: 500 });
    const grown = row("b", { storedCount: WARM_DEEP_ROWS, newestTs: 42, syncedCount: 400 });
    expect(planWarm([caught, grown])).toEqual([{ kind: "delta", id: "b", after: 42, serverCount: 500 }]);
  });

  it("skips rows in flight and rows with no messages yet", () => {
    expect(planWarm([row("x", { inFlight: true }), row("y", { serverCount: 0 })])).toEqual([]);
  });
});
