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
