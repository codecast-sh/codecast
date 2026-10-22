import { describe, expect, it } from "bun:test";
import type { BatchStats, LedgerCell, LedgerRow } from "../../contract";
import type { SurfaceColumn } from "./seismographModel";
import { ledgerPlate, plateColumnOf } from "./surfaceModel";

const HOUR = 60 * 60 * 1000;
const DAY0 = new Date(2026, 9, 1).getTime();

const col = (batch: string, day: number, hour: number): SurfaceColumn => ({ batch, at: DAY0 + day * 24 * HOUR + hour * HOUR, x: 0, stats: {} as BatchStats });
const cell = (reps: number, passed: number, mean: number | null = passed / reps): LedgerCell => ({ reps, passed, mean, majority: passed * 2 > reps, flip: null });
const row = (freezeId: string, cells: Record<string, LedgerCell>, flips = 0): LedgerRow => ({ freezeId, name: freezeId, visibility: "public", flips, cells });

describe("ledgerPlate", () => {
  it("keeps one column per batch, rows as sent, where most freezes run in a typical batch", () => {
    const columns = [col("n1", 0, 5), col("n2", 1, 5), col("n3", 2, 5)];
    const rows = [
      row("a", { n1: cell(2, 2), n2: cell(2, 0), n3: cell(2, 2) }, 2),
      row("b", { n1: cell(2, 2), n2: cell(2, 2), n3: cell(2, 2) }),
      row("c", { n2: cell(1, 1) }),
    ];
    const plate = ledgerPlate(rows, columns);
    expect(plate.by).toBe("batch");
    expect(plate.columns).toEqual(columns.map((c) => ({ key: c.batch, at: c.at, batches: [c.batch], batch: c.batch })));
    expect(plate.rows.map(({ batchOf, ...r }) => r)).toEqual(rows);
    expect(plate.rows[0].batchOf).toEqual({ n1: "n1", n2: "n2", n3: "n3" });
  });

  it("pools a sparse surface's batches by day, each well's majority over every rep that day", () => {
    // Ten freezes; a full run each night and gate runs of one freeze between.
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const columns = [col("full-0", 0, 5), col("g0a", 0, 9), col("g0b", 0, 11), col("full-1", 1, 5), col("g1a", 1, 9), col("g1b", 1, 10), col("g1c", 1, 12)];
    const rows = ids.map((id) =>
      row(id, {
        "full-0": cell(1, 1, 0.9),
        "full-1": cell(1, 1, 0.9),
        ...(id === "f0" ? { g0a: cell(2, 0, 0.2), g0b: cell(1, 0, 0.1), g1a: cell(1, 1, 0.8) } : {}),
        ...(id === "f1" ? { g1b: cell(1, 1) } : {}),
        ...(id === "f2" ? { g1c: cell(1, 0, 0) } : {}),
      }, id === "f0" ? 3 : 0),
    );
    const plate = ledgerPlate(rows, [...columns].reverse());
    expect(plate.by).toBe("day");
    expect(plate.columns.map((c) => c.batches)).toEqual([["full-0", "g0a", "g0b"], ["full-1", "g1a", "g1b", "g1c"]]);
    expect(plate.columns.map((c) => c.batch)).toEqual(["g0b", "g1c"]);
    const f0 = plate.rows.find((r) => r.freezeId === "f0")!;
    const [d0, d1] = plate.columns.map((c) => c.key);
    // Day 0: 1 of 4 reps passed, so the majority fails; day 1: 2 of 2.
    expect(f0.cells[d0]).toEqual({ reps: 4, passed: 1, mean: (0.9 + 0.2 * 2 + 0.1) / 4, majority: false, flip: null });
    expect(f0.cells[d1]).toMatchObject({ reps: 2, passed: 2, majority: true, flip: "fixed" });
    // The row keeps the server's run-to-run flips (3), which rank it, not the one day-to-day notch.
    expect(f0.flips).toBe(3);
    expect(f0.batchOf).toEqual({ [d0]: "g0b", [d1]: "g1a" });
    // A tie is no pass: 1 of 2 on day 1 holds f2's majority failing, so a flip from day 0's pass.
    const f2 = plate.rows.find((r) => r.freezeId === "f2")!;
    expect(f2.cells[d1]).toMatchObject({ reps: 2, passed: 1, majority: false, flip: "broke" });
    expect(plate.rows.find((r) => r.freezeId === "f5")!.flips).toBe(0);
  });

  it("measures a flip against the freeze's previous day with a verdict, skipping days it did not run or no rep scored", () => {
    const columns = [col("x", 0, 1), col("y", 1, 1), col("z", 2, 1), col("w", 3, 1), ...Array.from({ length: 4 }, (_, i) => col(`o${i}`, i, 2))];
    const unscored: LedgerCell = { reps: 1, passed: 0, mean: null, majority: null, flip: null };
    const others = Array.from({ length: 6 }, (_, i) => row(`o${i}`, { [`o${i % 4}`]: cell(1, 1) }));
    const plate = ledgerPlate([row("a", { x: cell(1, 1), y: unscored, w: cell(1, 0) }, 2), ...others], columns);
    expect(plate.by).toBe("day");
    const a = plate.rows[0];
    expect(plate.columns.map((c) => (a.cells[c.key] ? a.cells[c.key].flip : "-"))).toEqual([null, null, "-", "broke"]);
    expect(a.cells[plate.columns[1].key]).toMatchObject({ majority: null, mean: null });
    expect(a.flips).toBe(2);
  });

  it("finds the column a pinned or deep-linked batch sits in", () => {
    const ids = Array.from({ length: 6 }, (_, i) => `f${i}`);
    const columns = ids.map((id, i) => col(`b${i}`, Math.floor(i / 3), i));
    const plate = ledgerPlate(ids.map((id, i) => row(id, { [`b${i}`]: cell(1, 1) })), columns);
    expect(plate.by).toBe("day");
    expect(plateColumnOf(plate, "b1")).toBe(plate.columns[0]);
    expect(plateColumnOf(plate, "b4")).toBe(plate.columns[1]);
    expect(plateColumnOf(plate, "gone")).toBeNull();
    expect(plateColumnOf(plate, null)).toBeNull();
  });
});
