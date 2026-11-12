import { describe, expect, test } from "bun:test";
import { Workbook } from "./engine";

function wb(cells: Record<string, string>) {
  const w = new Workbook();
  w.setTabs([{ id: "s", name: "Sheet1" }]);
  const ch: Array<{ tab: string; col: number; row: number; input: string | null }> = [];
  for (const [ref, input] of Object.entries(cells)) ch.push({ tab: "s", col: ref.charCodeAt(0) - 64, row: Number(ref.slice(1)), input });
  w.update(ch);
  return w;
}
const v = (w: Workbook, ref: string) => w.value("s", ref.charCodeAt(0) - 64, Number(ref.slice(1)));
const set = (w: Workbook, ref: string, input: string | null) => w.update([{ tab: "s", col: ref.charCodeAt(0) - 64, row: Number(ref.slice(1)), input }]);

describe("spilling array formulas", () => {
  test("UNIQUE spills down, and readers of the spilled cells see it", () => {
    const w = wb({ A1: "Ana", A2: "Bo", A3: "Ana", A4: "Cy", C1: "=UNIQUE(A1:A4)", E1: "=COUNTA(C1:C10)", F1: "=C3" });
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3"), v(w, "C4")]).toEqual(["Ana", "Bo", "Cy", null]);
    expect(v(w, "E1")).toBe(3);
    expect(v(w, "F1")).toBe("Cy");
    expect(w.cell("s", 3, 2)).toMatchObject({ input: "", value: "Bo", spilled: true });
    expect(w.spillRange("s", 3, 1)).toEqual({ c0: 3, r0: 1, c1: 3, r1: 3 });
    // A changed name changes the block; its readers follow.
    set(w, "A4", "Dee");
    expect(v(w, "C3")).toBe("Dee");
    expect(v(w, "F1")).toBe("Dee");
    set(w, "A2", "Ana");
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3")]).toEqual(["Ana", "Dee", null]);
    expect(v(w, "F1")).toBe(null);
    expect(v(w, "E1")).toBe(2);
  });

  test("something in the way is #SPILL!, and clearing it lets the block back", () => {
    const w = wb({ A1: "3", A2: "1", A3: "2", C1: "=SORT(A1:A3)", C2: "x" });
    expect(v(w, "C1")).toMatchObject({ error: "#SPILL!" });
    set(w, "C2", null);
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3")]).toEqual([1, 2, 3]);
    // Typing into the block blocks it again.
    set(w, "C3", "y");
    expect(v(w, "C1")).toMatchObject({ error: "#SPILL!" });
    expect(v(w, "C2")).toBe(null);
  });

  test("FILTER, SORTBY, SEQUENCE, TRANSPOSE", () => {
    const w = wb({ A1: "Ana", B1: "5", A2: "Bo", B2: "9", A3: "Cy", B3: "2", D1: "=FILTER(A1:A3,B1:B3>3)", F1: "=SORTBY(A1:A3,B1:B3,-1)", H1: "=SEQUENCE(2,3,10,5)", H5: "=TRANSPOSE(A1:A3)" });
    expect([v(w, "D1"), v(w, "D2"), v(w, "D3")]).toEqual(["Ana", "Bo", null]);
    expect([v(w, "F1"), v(w, "F2"), v(w, "F3")]).toEqual(["Bo", "Ana", "Cy"]);
    expect([v(w, "H1"), v(w, "I1"), v(w, "J1"), v(w, "H2"), v(w, "J2")]).toEqual([10, 15, 20, 25, 35]);
    expect([v(w, "H5"), v(w, "I5"), v(w, "J5")]).toEqual(["Ana", "Bo", "Cy"]);
    set(w, "B3", "0");
    expect(v(w, "D3")).toBe(null);
    expect(w.value("s", 4, 1)).toBe("Ana");
  });

  test("deleting the formula clears its block", () => {
    const w = wb({ A1: "1", A2: "2", C1: "=SORT(A1:A2)", E1: "=SUM(C1:C2)" });
    expect(v(w, "E1")).toBe(3);
    set(w, "C1", null);
    expect(v(w, "C2")).toBe(null);
    expect(v(w, "E1")).toBe(0);
  });
});

describe("more functions", () => {
  test("SPLIT spills; COUNTUNIQUE, RANK, PMT, WORKDAY, REGEX*", () => {
    const w = wb({ A1: "Ana", A2: "ana", A3: "Bo", B1: "10", B2: "30", B3: "20", D1: "=SPLIT(\"x,y,3\",\",\")", D2: "=COUNTUNIQUE(A1:A3)", D3: "=RANK(20,B1:B3)", D4: "=ROUND(PMT(0.05/12,36,10000),2)", D5: "=WORKDAY(DATE(2026,11,13),1)", D6: "=REGEXEXTRACT(\"order 4521 ok\",\"(\\d+)\")", D7: "=REGEXMATCH(A1,\"^A\")", D8: "=REGEXREPLACE(\"a-b-c\",\"-\",\"+\")" });
    expect([v(w, "D1"), v(w, "E1"), v(w, "F1")]).toEqual(["x", "y", 3]);
    expect(v(w, "D2")).toBe(2);
    expect(v(w, "D3")).toBe(2);
    expect(v(w, "D4")).toBe(-299.71);
    expect(v(w, "D5")).toBe(46342);
    expect(v(w, "D6")).toBe("4521");
    expect(v(w, "D7")).toBe(true);
    expect(v(w, "D8")).toBe("a+b+c");
  });
});

describe("ranges with empty cells", () => {
  test("comparing a range that has blanks works (FILTER on non-empty, SUMPRODUCT counts)", () => {
    const w = wb({ A2: "Ana", A3: "Bo", C1: '=FILTER(A2:A10,A2:A10<>"")', D1: '=SUMPRODUCT(--(A2:A10<>""))', E1: '=SUMPRODUCT((A2:A10="Ana")*1)' });
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3")]).toEqual(["Ana", "Bo", null]);
    expect(v(w, "D1")).toBe(2);
    expect(v(w, "E1")).toBe(1);
  });
});

import { shiftFormula, adjustFormula } from "./rewrite";
describe("open-ended column ranges", () => {
  test("A2:A reads to the bottom of the used rows, shifts and survives row edits", () => {
    const w = wb({ A1: "head", A2: "2", A3: "3", A9: "4", C1: "=SUM(A2:A)", D1: "=COUNTA(UNIQUE(A2:A))" });
    expect(v(w, "C1")).toBe(9);
    set(w, "A20", "1");
    expect(v(w, "C1")).toBe(10);
    expect(shiftFormula("=SUM(A2:A)", 1, 3)).toBe("=SUM(B5:B)");
    expect(adjustFormula("=SUM(A2:A)", "S", { tabName: "S", axis: "row", at: 1, count: 1 })).toBe("=SUM(A3:A)");
    expect(adjustFormula("=SUM(A5:A)", "S", { tabName: "S", axis: "row", at: 2, count: -2 })).toBe("=SUM(A3:A)");
    expect(adjustFormula("=SUM(A2:B)", "S", { tabName: "S", axis: "col", at: 1, count: 1 })).toBe("=SUM(B2:C)");
  });
});

import { sheetSpec } from "../sheet";
import { doc } from "./sheetDoc.testkit";
import { buildModel } from "./model";
describe("fit with spills", () => {
  test("a column holding only a spilled block fits its widest value", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "a rather long project title here\nb");
    d.verb("set", ["C1", "=UNIQUE(A1:A2)"]);
    d.apply(sheetSpec.verbs!.fit.run(d.view(), ["C"]).ops);
    const m = buildModel(d.elements());
    expect(m.byId.get(m.tabs[0].id)!.colWidths.get(3)! > 150).toBe(true);
  });
});

import { inheritedFormat } from "./model";
describe("round 2 critic: spills and arrays", () => {
  test("SORT FALSE sorts descending; arrays; E1# reads a block and follows it", () => {
    const w = wb({ A1: "3", A2: "1", A3: "2", C1: "=SORT(A1:A3,1,FALSE)", E1: "=RANK(3,{1,3,5})", F1: "=SUM({1,2;3,4})", G1: "=UNIQUE(A1:A3)", H1: "=ROWS(G1#)", H2: "=SUM(G1#)" });
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3")]).toEqual([3, 2, 1]);
    expect(v(w, "E1")).toBe(2);
    expect(v(w, "F1")).toBe(10);
    expect(v(w, "H1")).toBe(3);
    set(w, "A4", "9");
    set(w, "G1", "=UNIQUE(A1:A4)");
    expect(v(w, "H1")).toBe(4);
    expect(v(w, "H2")).toBe(15);
  });
  test("#SPILL! names the cell in the way; date and money functions carry a format", () => {
    const w = wb({ A1: "1", A2: "2", C1: "=SORT(A1:A2)", C2: "x" });
    expect(v(w, "C1")).toMatchObject({ error: "#SPILL!", message: "C2 is in the way of C1:C2" });
    const m = buildModel([]);
    expect(inheritedFormat(m, m.tabs[0].id, "=WORKDAY(TODAY(),3)")).toEqual({ nf: "date" });
    expect(inheritedFormat(m, m.tabs[0].id, "=PMT(0.05/12,36,10000)")).toEqual({ nf: "currency", dp: 2 });
  });
});

import { formatValue } from "./format";
import { parseLiteral } from "./values";
describe("times of day", () => {
  test("typed times are values; sums run past a day; TIME and TIMEVALUE", () => {
    expect(parseLiteral("9:15 PM")).toEqual({ value: 21.25 / 24, implied: { nf: "time" } });
    const w = wb({ A1: "8:30", A2: "17:45", B1: "=A2-A1", B2: "=TIME(1,30,0)", B3: "=TIMEVALUE(\"10:30\")*24", B4: "=B1*24" });
    expect(formatValue(v(w, "B1"), { nf: "time" })).toBe("9:15");
    expect(v(w, "B3")).toBe(10.5);
    expect(v(w, "B4")).toBeCloseTo(9.25);
    expect(formatValue(1.25, { nf: "time" })).toBe("30:00");
    expect(parseLiteral("€1,234")).toEqual({ value: 1234, implied: { nf: "currency", dp: 0, cur: "€" } });
  });
});

describe("more everyday functions", () => {
  test("LARGE, SMALL, PERCENTILE, MROUND, WEEKNUM, ISOWEEKNUM, FV, NPV, CORREL, SUBTOTAL", () => {
    const w = wb({ A1: "4", A2: "9", A3: "1", A4: "7", B1: "2", B2: "4", B3: "6", B4: "8",
      C1: "=LARGE(A1:A4,2)", C2: "=SMALL(A1:A4,1)", C3: "=PERCENTILE(A1:A4,0.5)", C4: "=MROUND(17,5)",
      D1: "=WEEKNUM(DATE(2026,1,1))", D2: "=ISOWEEKNUM(DATE(2026,1,1))", D3: "=ISOWEEKNUM(DATE(2026,12,31))", D4: "=WEEKNUM(DATE(2026,3,15))",
      E1: "=ROUND(FV(0.05,10,-100),2)", E2: "=ROUND(NPV(0.1,100,100),2)", E3: "=CORREL(B1:B4,B1:B4)", E4: "=SUBTOTAL(9,A1:A4)" });
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3"), v(w, "C4")]).toEqual([7, 1, 5.5, 15]);
    expect([v(w, "D1"), v(w, "D2"), v(w, "D3"), v(w, "D4")]).toEqual([1, 1, 53, 12]);
    expect([v(w, "E1"), v(w, "E2"), v(w, "E3"), v(w, "E4")]).toEqual([1257.79, 173.55, 1, 21]);
  });
});

describe("stacking and slicing", () => {
  test("VSTACK, HSTACK, TAKE, DROP, CHOOSECOLS, TOCOL spill; IRR, ADDRESS, FORECAST compute", () => {
    const w = wb({
      A1: "1", B1: "2", A2: "3", B2: "4",
      D1: "=VSTACK(A1:B2,A1:A1)",
      G1: "=TAKE(A1:B2,-1)",
      G3: "=CHOOSECOLS(A1:B2,-1)",
      G6: "=TOCOL(A1:B2)",
      I1: "=HSTACK(A1:A2,B1:B2,A1:A2)",
      I4: "=DROP(A1:B2,1,1)",
      M1: "=IRR({-100,60,60})",
      M2: '=ADDRESS(2,28,4,TRUE,"My tab")',
      M3: "=FORECAST(4,A1:A2,B1:B2)",
    });
    expect([v(w, "D3"), v(w, "E3"), v(w, "F3")]).toEqual([1, expect.objectContaining({ error: "#N/A" }), null]);
    expect([v(w, "G1"), v(w, "H1"), v(w, "G2")]).toEqual([3, 4, null]);
    expect([v(w, "G3"), v(w, "G4")]).toEqual([2, 4]);
    expect(["G6", "G7", "G8", "G9"].map((r) => v(w, r))).toEqual([1, 2, 3, 4]);
    expect([v(w, "I1"), v(w, "J1"), v(w, "K2")]).toEqual([1, 2, 3]);
    expect(v(w, "I4")).toBe(4);
    expect(Number((v(w, "M1") as number).toFixed(4))).toBe(0.1307);
    expect(v(w, "M2")).toBe("'My tab'!AB2");
    expect(v(w, "M3")).toBe(3);
  });
});

describe("references worked out while evaluating", () => {
  test("OFFSET, INDIRECT, LET and FORMULATEXT; OFFSET follows a change to the cell it lands on", () => {
    const w = wb({ A1: "1", A2: "2", A3: "3", B1: "Total", C1: "=OFFSET(A1,2,0)", C2: "=SUM(OFFSET(A1,0,0,3,1))", C3: '=INDIRECT("A"&2)', C4: "=LET(x,A1*10,y,x+A2,y*2)", C5: "=FORMULATEXT(C4)", C6: '=INDIRECT("Nope!A1")' });
    expect([v(w, "C1"), v(w, "C2"), v(w, "C3"), v(w, "C4"), v(w, "C5")]).toEqual([3, 6, 2, 24, "=LET(x,A1*10,y,x+A2,y*2)"]);
    expect(v(w, "C6")).toMatchObject({ error: "#REF!" });
    set(w, "A3", "30");
    expect([v(w, "C1"), v(w, "C2")]).toEqual([30, 33]);
  });
});
