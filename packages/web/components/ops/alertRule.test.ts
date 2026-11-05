import { describe, expect, test } from "bun:test";
import { backtest } from "./alertRule";

const M = 60_000;
const pts = (vals: number[]) => vals.map((value, i) => ({ at: i * M, value }));

describe("backtest", () => {
  test("one read past the line alerts, the next read inside clears it", () => {
    const b = backtest(pts([1, 5, 1, 1, 6, 6, 1]), { threshold: 3, direction: "above" }, 10 * M);
    expect(b.alerts).toEqual([{ from: M, to: 2 * M, open: false }, { from: 4 * M, to: 6 * M, open: false }]);
    expect(b.total).toBe(3 * M);
  });

  test("reads in a row ignore a single spike, as the monitor does", () => {
    const b = backtest(pts([1, 5, 1, 6, 6, 1, 1]), { threshold: 3, direction: "above", eval_reads: 2 }, 10 * M);
    expect(b.alerts).toEqual([{ from: 4 * M, to: 6 * M, open: false }]);
  });

  test("an alert still running at the last read is open to now", () => {
    const b = backtest(pts([5, 1, 0]), { threshold: 2, direction: "below" }, 9 * M);
    expect(b.alerts).toEqual([{ from: M, to: 9 * M, open: true }]);
  });

  test("never past the line raises nothing", () => {
    expect(backtest(pts([1, 2, 1]), { threshold: 9, direction: "above" }, 3 * M)).toEqual({ alerts: [], total: 0 });
  });
});
