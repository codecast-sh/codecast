import { describe, expect, test } from "bun:test";
import { paintCell, type PaintContext } from "./cellPaint";

const ctx = (over: Partial<PaintContext> = {}): PaintContext => ({ tables: [], conds: [], scaleRange: () => null, ...over });
const table = { key: "tbl:1", tab: "Sheet1", rect: { c0: 1, r0: 1, c1: 3, r1: 5 }, color: "blue" as const, banded: true };

describe("paintCell", () => {
  test("a table header shows a year as typed even under a number format", () => {
    const el = { key: "c:Sheet1!B1", kind: "cell", rev: 1, input: "2025", nf: "number" as const };
    expect(paintCell(el as any, 2025, undefined, 2, 1, ctx({ tables: [table] })).text).toBe("2025");
    // The same cell outside a table header keeps its format.
    expect(paintCell(el as any, 2025, undefined, 2, 1, ctx()).text).toBe("2,025");
    expect(paintCell({ ...el, key: "c:Sheet1!B2" } as any, 21000, undefined, 2, 2, ctx({ tables: [table] })).text).toBe("21,000");
  });
  test("a header over a numeric column aligns right and is bold", () => {
    const el = { key: "c:Sheet1!B1", kind: "cell", rev: 1, input: "2025 actual" };
    const p = paintCell(el as any, "2025 actual", undefined, 2, 1, ctx({ tables: [table], numericAt: () => true }));
    expect(p.align).toBe("right");
    expect(p.bold).toBe(true);
  });
  test("a formula over a formatted cell takes its format", () => {
    const el = { key: "c:Sheet1!B18", kind: "cell", rev: 1, input: "=MAX(B15:E15)" };
    const p = paintCell(el as any, 24726, undefined, 2, 18, ctx({ inherited: () => ({ nf: "number" }) }));
    expect(p.text).toBe("24,726");
  });
});

describe("validation paint", () => {
  const list = { key: "dv:1", tab: "Sheet1", rect: { c0: 3, r0: 2, c1: 3, r1: 50 }, rule: "list" as const, strict: false, options: [{ v: "Offer", color: "green" as const }, { v: "Screen" }] };
  const date = { ...list, key: "dv:2", rule: "date" as const, options: [] };
  const el = (input: string) => ({ key: "c:Sheet1!C2", kind: "cell", rev: 1, input }) as any;
  test("a listed value paints as a chip in its color, any case", () => {
    const p = paintCell(el("offer"), "offer", undefined, 3, 2, ctx({ validation: () => list }));
    expect(p.picker).toBe("list");
    expect(p.chip?.fill).toContain("--sol-green");
    expect(p.invalid).toBeUndefined();
    expect(paintCell(el("Screen"), "Screen", undefined, 3, 2, ctx({ validation: () => list })).chip?.fill).toContain("--sol-text-muted");
  });
  test("a value outside the list is flagged; an empty cell is not", () => {
    expect(paintCell(el("Maybe"), "Maybe", undefined, 3, 2, ctx({ validation: () => list })).invalid).toBe(true);
    const empty = paintCell(undefined, null, undefined, 3, 2, ctx({ validation: () => list }));
    expect(empty.invalid).toBeUndefined();
    expect(empty.picker).toBe("list");
  });
  test("a date cell flags text that is not a date", () => {
    expect(paintCell(el("2026-11-12"), 46338, { nf: "date" }, 3, 2, ctx({ validation: () => date })).invalid).toBeUndefined();
    expect(paintCell(el("soon"), "soon", undefined, 3, 2, ctx({ validation: () => date })).invalid).toBe(true);
  });
});

import { fitNumber } from "./cellPaint";
describe("fitNumber", () => {
  test("rounds decimals to the column, then goes scientific", () => {
    expect(fitNumber("0.708759085123", 0.708759085123, 104)).toBe("0.708759085");
    expect(fitNumber("0.7087", 0.7087, 104)).toBe("0.7087");
    expect(fitNumber("-12.3456789", -12.3456789, 70)).toBe("-12.346");
    expect(fitNumber("123456789012", 123456789012, 70)).toBe("1.2E+11");
  });
});
