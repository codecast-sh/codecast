import { describe, expect, test } from "bun:test";
import { sheetSpec } from "../sheet";
import { buildModel, LiveSheet, validationAt } from "./model";
import { doc } from "./sheetDoc.testkit";
import { structuralOps } from "./ops";

describe("validation", () => {
  test("list with chip colors, describe line, restyle in place, clear", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("validate", ["C2:C40", "list", "Applied:gray, Screen:blue,Offer:green,Screen", "--strict"]);
    let m = buildModel(d.elements());
    expect(m.validations).toHaveLength(1);
    expect(m.validations[0]).toMatchObject({ rule: "list", strict: true, options: [{ v: "Applied", color: "gray" }, { v: "Screen", color: "blue" }, { v: "Offer", color: "green" }] });
    expect(validationAt(m, m.tabs[0].id, 3, 10)?.rule).toBe("list");
    expect(validationAt(m, m.tabs[0].id, 4, 10)).toBeUndefined();
    expect(sheetSpec.describe(d.view())).toContain("validate C2:C40 list Applied:gray,Screen:blue,Offer:green --strict");
    d.verb("validate", ["C2:C40", "date"]);
    m = buildModel(d.elements());
    expect(m.validations).toHaveLength(1);
    expect(m.validations[0].rule).toBe("date");
    d.verb("validate", ["C2:C40", "clear"]);
    expect(buildModel(d.elements()).validations).toHaveLength(0);
    expect(() => d.verb("validate", ["C2:C4", "list", "A:pink"])).toThrow(/color must be/);
    expect(() => d.verb("validate", ["C2:C4", "list"])).toThrow(/needs its values/);
  });

  test("inserting rows above moves the range; LiveSheet matches a rebuild", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("validate", ["B2:B10", "list", "x,y"]);
    const live = new LiveSheet();
    live.update(d.elements());
    const m = buildModel(d.elements());
    d.apply(structuralOps(m, m.tabs[0].id, "row", 1, 2));
    live.update(d.elements());
    expect(buildModel(d.elements()).validations[0].rect).toEqual({ c0: 2, c1: 2, r0: 4, r1: 12 });
    expect(live.model.validations).toEqual(buildModel(d.elements()).validations);
  });
});

import { parseTable } from "./ops";
describe("parseTable", () => {
  test("sniffs CSV, TSV and semicolons; quoted fields keep commas and line breaks", () => {
    expect(parseTable('Name,Note,Amount\nPie,"a, b",12\n"Tart ""v2""","line\nbreak",8\n')).toEqual([["Name", "Note", "Amount"], ["Pie", "a, b", "12"], ['Tart "v2"', "line\nbreak", "8"]]);
    expect(parseTable("a\tb,c\n1\t2")).toEqual([["a", "b,c"], ["1", "2"]]);
    expect(parseTable("a;b\r\n1,5;2")).toEqual([["a", "b"], ["1,5", "2"]]);
  });
});

import { importTablesOps } from "./ops";
describe("importTablesOps", () => {
  test("each table becomes a new tab with a unique name and fitted columns", () => {
    const d = doc(sheetSpec.seed!());
    const m0 = buildModel(d.elements());
    const r = importTablesOps(m0, [{ name: m0.tabs[0].name, grid: [["Name", "A rather long header"], ["Pie", "12"]] }, { name: "Notes", grid: [["x"]] }]);
    d.apply(r.ops);
    const m = buildModel(d.elements());
    expect(m.tabs.map((t) => t.name)).toEqual([m0.tabs[0].name, `${m0.tabs[0].name} 2`, "Notes"]);
    expect(new Set(r.tabIds).size).toBe(2);
    const t = m.byId.get(r.tabIds[0])!;
    expect(t.rows).toBe(2);
    expect(t.colWidths.get(2)! > t.colWidths.get(1)!).toBe(true);
    expect(sheetSpec.verbs!.range.run(d.view(), [`'${m0.tabs[0].name} 2'!A1:B2`]).status).toBe("Name\tA rather long header\nPie\t12");
  });
});

describe("import verb", () => {
  test("CSV on stdin lands in a new tab", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("import", ["Q4", "orders"], 'flavor,boxes\n"Pecan, salted",120\n');
    expect(sheetSpec.verbs!.range.run(d.view(), ["'Q4 orders'!A1:B2"]).status).toBe("flavor\tboxes\nPecan, salted\t120");
  });
});

import { validateInput } from "./ops";
describe("validateInput", () => {
  const list = { rule: "list" as const, options: [{ v: "Offer" }, { v: "Screen" }], strict: true };
  test("strict lists refuse, take any case, and leave formulas and blanks alone", () => {
    expect(validateInput(list, "offer")).toEqual({ input: "Offer" });
    expect("refuse" in validateInput(list, "Maybe")).toBe(true);
    expect(validateInput({ ...list, strict: false }, "Maybe")).toEqual({ input: "Maybe" });
    expect(validateInput(list, "=A1")).toEqual({ input: "=A1" });
    expect(validateInput(list, "")).toEqual({ input: "" });
  });
  test("strict dates take dates only", () => {
    const date = { rule: "date" as const, options: [], strict: true };
    expect(validateInput(date, "2026-11-12")).toEqual({ input: "2026-11-12" });
    expect("refuse" in validateInput(date, "soon")).toBe(true);
  });
});
