import { describe, expect, test } from "bun:test";
import type { PriorityHistory, PriorityHistoryLane } from "@codecast/shared/contracts/priorities";
import { barHeight, busiestFirst, dayAriaLabel, dayDate, dayTotals, percent, segmentHeights, splitDays, type BreakdownDay, type WorkspaceDays } from "../priorityBreakdown";

const lane = (short_id: string | null, counts: number[], extra: Partial<PriorityHistoryLane> = {}): PriorityHistoryLane => ({
  key: short_id ?? "unassigned", short_id, title: short_id ?? "Unassigned", status: short_id ? "active" : null, counts, total: counts.reduce((a, b) => a + b, 0), ...extra,
});
const row = (short_id: string, rank: number | null, extra: { mine?: boolean; status?: "active" | "quiet" | "done" } = {}) => ({ short_id, rank, mine: extra.mine ?? true, status: extra.status ?? "active" }) as const;
const day = (top: number, rest: number, none: number): BreakdownDay => ({ top, rest, none, total: top + rest + none });

describe("splitDays", () => {
  const history: PriorityHistory = {
    days: ["2026-11-24", "2026-11-25", "2026-11-26"],
    lanes: [
      lane("pri-1", [1, 2, 3]),
      lane("pri-4", [10, 0, 1]),
      lane("pri-old", [0, 5, 0]),
      lane(null, [4, 0, 2]),
      lane("pri-team", [7, 7, 7], { owner: "Sam" }),
      lane(null, [5, 5, 5], { owner: "" }),
    ],
  };
  const rows = [row("pri-1", 3), row("pri-4", 4), row("pri-team", 1, { mine: false }), row("pri-old", 2, { status: "done" })];

  test("ranks 1–3 are top, other priority lanes rest, lanes without a priority none; teammates' lanes skipped, even one with a blank name", () => {
    expect(splitDays(history, rows, history.days)).toEqual([day(1, 10, 4), day(2, 5, 0), day(3, 1, 2)]);
  });

  test("a day missing from history, and every day without history, is zero", () => {
    expect(splitDays(history, rows, ["2026-11-23", "2026-11-26"])).toEqual([day(0, 0, 0), day(3, 1, 2)]);
    expect(splitDays(undefined, rows, ["2026-11-26"])).toEqual([day(0, 0, 0)]);
  });

  test("a lane whose priority is not in the list, or has no rank, counts as 4+", () => {
    const h: PriorityHistory = { days: ["d"], lanes: [lane("pri-x", [2]), lane("pri-n", [3])] };
    expect(splitDays(h, [row("pri-n", null)], ["d"])).toEqual([day(0, 5, 0)]);
  });

  test("a teammate's row with a top rank does not lift the viewer's lane of the same id", () => {
    const h: PriorityHistory = { days: ["d"], lanes: [lane("pri-1", [2])] };
    expect(splitDays(h, [row("pri-1", 1, { mine: false })], ["d"])).toEqual([day(0, 2, 0)]);
  });
});

const space = (workspace: string, days: BreakdownDay[]): WorkspaceDays => ({ workspace, name: workspace, days, total: days.reduce((c, d) => c + d.total, 0) });

test("busiestFirst drops empty workspaces and sorts by total, descending", () => {
  const spaces = [space("a", [day(1, 0, 0)]), space("b", [day(0, 0, 0)]), space("c", [day(2, 2, 0)])];
  expect(busiestFirst(spaces).map((s) => s.workspace)).toEqual(["c", "a"]);
});

test("dayTotals sums every workspace per day", () => {
  expect(dayTotals([space("a", [day(1, 0, 0), day(0, 0, 3)]), space("b", [day(0, 2, 0), day(0, 0, 0)])], 2)).toEqual([3, 3]);
});

describe("bars", () => {
  test("height is a sqrt scale against the peak, zero for an empty day", () => {
    expect(barHeight(day(0, 0, 0), 100, 28)).toBe(0);
    expect(barHeight(day(100, 0, 0), 100, 28)).toBe(28);
    expect(barHeight(day(25, 0, 0), 100, 28)).toBe(14);
    // A quiet day still shows, with room for each of its parts.
    expect(barHeight(day(1, 0, 0), 10_000, 28)).toBe(4);
    expect(barHeight(day(1, 1, 1), 10_000, 28)).toBe(8);
  });

  test("segments sum to the bar less its gaps and keep 2px each", () => {
    const d = day(10, 1, 1);
    const h = segmentHeights(d, 20);
    expect(h.top + h.rest + h.none).toBe(20 - 2);
    expect(Math.min(h.rest, h.none)).toBeGreaterThanOrEqual(2);
    expect(h.top).toBeGreaterThan(h.rest);
    expect(segmentHeights(day(0, 3, 0), 9)).toEqual({ top: 0, rest: 9, none: 0 });
    expect(segmentHeights(day(0, 0, 0), 9)).toEqual({ top: 0, rest: 0, none: 0 });
  });
});

test("percent, dayDate and a day column's accessible text", () => {
  expect(percent(1, 3)).toBe(33);
  expect(percent(1, 0)).toBe(0);
  expect(dayDate("2026-11-25")).toBe("Wed, Nov 25");
  expect(dayAriaLabel("Today", day(6, 4, 2))).toBe("Today: 12 messages, 1–3 6, 4+ 4, no priority 2");
  expect(dayAriaLabel("Wed, Nov 25", day(0, 0, 1))).toBe("Wed, Nov 25: 1 message, 1–3 0, 4+ 0, no priority 1");
});
