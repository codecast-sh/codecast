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

import { validateInput } from "./ruleOps";
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

import { enforceValidation } from "./ruleOps";
describe("enforceValidation", () => {
  test("strict cells drop refused writes from any batch; listed values take their case", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("validate", ["B2:B10", "list", "Open,Done", "--strict"]);
    const m = buildModel(d.elements());
    const id = m.tabs[0].id;
    const r = enforceValidation(m, [
      { k: `c:${id}!B2`, put: { kind: "cell", input: "Hired" } },
      { k: `c:${id}!B3`, set: { input: "done" } },
      { k: `c:${id}!C3`, put: { kind: "cell", input: "anything" } },
      { k: `c:${id}!B4`, set: { b: true } },
    ]);
    expect(r.refused).toBe(1);
    expect(r.ops.map((o) => o.k)).toEqual([`c:${id}!B3`, `c:${id}!C3`, `c:${id}!B4`]);
    expect((r.ops[0] as any).set.input).toBe("Done");
  });
});

describe("hide and unhide", () => {
  test("columns and rows hide and show, keep their size, and read in describe", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("width", ["B", "200"]);
    d.verb("hide", ["cols", "B:C"]);
    d.verb("hide", ["rows", "4"]);
    let t = buildModel(d.elements()).byId.get(buildModel(d.elements()).tabs[0].id)!;
    expect([...t.hiddenCols!].sort()).toEqual([2, 3]);
    expect([...t.hiddenRows!]).toEqual([4]);
    expect(t.colWidths.get(2)).toBe(200);
    expect(sheetSpec.describe(d.view())).toContain("hidden cols B,C · hidden rows 4");
    const live = new LiveSheet();
    live.update(d.elements());
    d.verb("unhide", ["cols", "B:C"]);
    live.update(d.elements());
    t = buildModel(d.elements()).byId.get(buildModel(d.elements()).tabs[0].id)!;
    expect(t.hiddenCols?.size ?? 0).toBe(0);
    expect(t.colWidths.get(2)).toBe(200);
    expect(live.model.byId.get(t.meta.id)!.hiddenCols?.size ?? 0).toBe(0);
    expect([...live.model.byId.get(t.meta.id)!.hiddenRows!]).toEqual([4]);
  });
});

import { formatValue } from "./format";
describe("number formats", () => {
  test("accounting, scientific, other currencies and custom codes", () => {
    expect(formatValue(-1234.5, { nf: "accounting" })).toBe("($1,234.50)");
    expect(formatValue(1234.5, { nf: "currency", cur: "€" })).toBe("€1,234.50");
    expect(formatValue(12345.678, { nf: "scientific" })).toBe("1.23E+04");
    expect(formatValue(1234.56, { nf: "custom", code: '#,##0.0 "kg"' })).toBe("1,234.6 kg");
  });
  test("the fmt verb sets them and describe reads them back", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "1234.5\n2");
    d.verb("fmt", ["A1", "cur=€"]);
    d.verb("fmt", ["A2", 'code="0.0 \\"kg\\""']);
    const out = sheetSpec.describe(d.view());
    expect(out).toContain("nf=currency cur=€");
    expect(out).toContain("nf=custom");
    expect(sheetSpec.verbs!.range.run(d.view(), ["A1:A2"]).status).toBe("1234.5\n2");
  });
});

describe("conditional rules", () => {
  test("date rules and text rules stack on one range; describe lists them", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("cond", ["C2:C40", "before", "today", "red"]);
    d.verb("cond", ["C2:C40", "after", "2026-12-31", "green"]);
    d.verb("cond", ["C2:C40", "before", "today", "orange"]);
    const conds = buildModel(d.elements()).conds;
    expect(conds.map((c) => [c.rule, c.value, c.color])).toEqual([["before", "today", "orange"], ["after", "2026-12-31", "green"]]);
    expect(sheetSpec.describe(d.view())).toContain("cond C2:C40 before today orange");
  });
});

import { expandToMerges } from "./ruleOps";
describe("merged cells", () => {
  test("merge, describe, selection expands, unmerge; inserting a row moves the merge", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("merge", ["A1:D1"]);
    let m = buildModel(d.elements());
    expect(m.merges.map((x) => x.rect)).toEqual([{ c0: 1, r0: 1, c1: 4, r1: 1 }]);
    expect(sheetSpec.describe(d.view())).toContain("merged A1:D1");
    expect(expandToMerges(m, m.tabs[0].id, { c0: 2, r0: 1, c1: 2, r1: 2 })).toEqual({ c0: 1, r0: 1, c1: 4, r1: 2 });
    d.apply(structuralOps(m, m.tabs[0].id, "row", 1, 1));
    m = buildModel(d.elements());
    expect(m.merges[0].rect).toEqual({ c0: 1, r0: 2, c1: 4, r1: 2 });
    d.verb("unmerge", ["B2"]);
    expect(buildModel(d.elements()).merges).toHaveLength(0);
  });
});

describe("agents and strict cells", () => {
  test("set into a strict dropdown is skipped and says so", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("validate", ["B2:B10", "list", "Open,Done", "--strict"]);
    const r = sheetSpec.verbs!.set.run(d.view(), ["B2", "Maybe"]);
    expect(r.status).toContain("skipped 1 value");
    expect(r.ops.some((o) => o.k.endsWith("!B2"))).toBe(false);
    expect(sheetSpec.verbs!.set.run(d.view(), ["B2", "done"]).ops.find((o) => o.k.endsWith("!B2"))).toBeTruthy();
  });
});
