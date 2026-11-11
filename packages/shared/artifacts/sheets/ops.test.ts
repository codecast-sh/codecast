import { describe, expect, test } from "bun:test";
import { doc } from "./sheetDoc.testkit";
import { sheetSpec, readSheetRange, describeSheet } from "../sheet";
import { adjustFormula, renameTabInFormula, shiftFormula } from "./rewrite";
import { buildModel, workbookFor } from "./model";
import { fillOps, parseTsv, structuralOps, sortOps, toTsv, clipOf, pasteClipOps } from "./ops";

describe("rewrite", () => {
  test("relative shift keeps anchors", () => {
    expect(shiftFormula("=B2*(1+C2)", 0, 1)).toBe("=B3*(1+C3)");
    expect(shiftFormula("=$B$2+B$2+$B2", 1, 1)).toBe("=$B$2+C$2+$B3");
    expect(shiftFormula("=A1", 0, -1)).toBe("=#REF!");
    expect(shiftFormula("=SUM(Historical!B2:B5)", 1, 0)).toBe("=SUM(Historical!C2:C5)");
  });
  test("insert and delete rows", () => {
    const ins = { tabName: "Sheet1", axis: "row" as const, at: 3, count: 2 };
    expect(adjustFormula("=SUM(B2:B5)+B2+B3", "Sheet1", ins)).toBe("=SUM(B2:B7)+B2+B5");
    expect(adjustFormula("=SUM(B2:B5)", "Other", ins)).toBe("=SUM(B2:B5)");
    expect(adjustFormula("=SUM(Sheet1!B2:B5)", "Other", ins)).toBe("=SUM(Sheet1!B2:B7)");
    const del = { tabName: "Sheet1", axis: "row" as const, at: 3, count: -2 };
    expect(adjustFormula("=SUM(B2:B6)+B3+B7", "Sheet1", del)).toBe("=SUM(B2:B4)+#REF!+B5");
    expect(adjustFormula("=SUM(B3:B4)", "Sheet1", del)).toBe("=SUM(#REF!)");
    expect(adjustFormula("=SUM(A:A)", "Sheet1", del)).toBe("=SUM(A:A)");
  });
  test("tab rename", () => {
    expect(renameTabInFormula("=Historical!B2+'historical'!C3+B2", "Historical", "Last year")).toBe("='Last year'!B2+'Last year'!C3+B2");
  });
});

describe("tsv", () => {
  test("Sheets/Excel clipboard: quoted cells with tabs, newlines and quotes", () => {
    expect(parseTsv('a\tb\r\n"multi\nline"\t"say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["multi\nline", 'say "hi"'],
    ]);
    expect(parseTsv("1\t\t3")).toEqual([["1", "", "3"]]);
    const grid = [["x\ty", 'q"'], ["", "z"]];
    expect(parseTsv(toTsv(grid))).toEqual(grid);
  });
});

describe("verbs and ops", () => {
  test("an agent drafts a forecast: write, formulas, formats, read back", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("tab", ["rename", "Sheet1", "Forecast"]);
    d.verb("write", ["Historical!A1"], "Channel\t2025 actual\nWebsite\t21000\nEmail list\t14000\n");
    d.verb("write", ["A1"], "Channel\t2025 actual\tGrowth\tForecast\nWebsite\t=Historical!B2\t10%\t=B2*(1+C2)\nEmail list\t=Historical!B3\t5%\t=B3*(1+C3)\nTotal\t=SUM(B2:B3)\t=D4/B4-1\t=SUM(D2:D3)");
    d.verb("fmt", ["A1:D1", "b", "fill=blue"]);
    d.verb("fmt", ["C2:C4", "pct", "dp=1", "sign"]);
    const r = readSheetRange(d.elements(), "Forecast!A1:D4");
    expect(r).toEqual({
      tab: "Forecast",
      rect: "A1:D4",
      values: [
        ["Channel", "2025 actual", "Growth", "Forecast"],
        ["Website", 21000, 0.1, expect.closeTo(23100) as unknown as number],
        ["Email list", 14000, 0.05, expect.closeTo(14700) as unknown as number],
        ["Total", 35000, expect.closeTo(0.08) as unknown as number, expect.closeTo(37800) as unknown as number],
      ],
    });
    const text = describeSheet(d.view());
    expect(text).toContain("[Forecast]");
    expect(text).toContain("D2 =B2*(1+C2) → 23100");
    expect(text).toContain("C4 =D4/B4-1 → +8.0%");
    expect(text).toContain("A1:D1 b fill=blue");
    expect(text).toContain("[Historical]");
  });

  test("insert a row keeps totals right, across tabs", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "a\t1\nb\t2\nTotal\t=SUM(B1:B2)");
    d.verb("write", ["Summary!A1"], "=Sheet1!B3");
    d.verb("insert", ["rows", "Sheet1!2"]);
    expect(d.input("c:Sheet1!B4")).toBe("=SUM(B1:B3)");
    expect(d.input("c:Sheet1!A2")).toBeUndefined();
    expect(d.input("c:Sheet1!B3")).toBe("2");
    expect(d.input("c:t1!A1")).toBe("=Sheet1!B4");
    d.verb("delete", ["rows", "Sheet1!1:2"]);
    expect(d.input("c:Sheet1!B2")).toBe("=SUM(B1:B1)");
    expect(d.input("c:t1!A1")).toBe("=Sheet1!B2");
  });

  test("fill handle: series, count-up text, shifted formulas", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "1\tItem 1\t=A1*2\n3\t\t");
    const m = buildModel(d.elements());
    d.apply(fillOps(m, "Sheet1", { c0: 1, r0: 1, c1: 1, r1: 2 }, { c0: 1, r0: 1, c1: 1, r1: 5 }));
    expect([3, 4, 5].map((r) => d.input(`c:Sheet1!A${r}`))).toEqual(["5", "7", "9"]);
    d.apply(fillOps(buildModel(d.elements()), "Sheet1", { c0: 2, r0: 1, c1: 3, r1: 1 }, { c0: 2, r0: 1, c1: 3, r1: 3 }));
    expect(d.input("c:Sheet1!B3")).toBe("Item 3");
    expect(d.input("c:Sheet1!C3")).toBe("=A3*2");
  });

  test("sort moves rows and their formulas", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "Name\tN\tDouble\nb\t2\t=B2*2\nc\t3\t=B3*2\na\t1\t=B4*2");
    d.verb("sort", ["A2:C4", "by", "B", "desc"]);
    expect(readSheetRange(d.elements(), "A2:C4")).toMatchObject({ values: [["c", 3, 6], ["b", 2, 4], ["a", 1, 2]] });
    const m = buildModel(d.elements());
    d.apply(sortOps(m, workbookFor(m), "Sheet1", { c0: 1, r0: 2, c1: 3, r1: 4 }, 1));
    expect(readSheetRange(d.elements(), "A2:A4")).toMatchObject({ values: [["a"], ["b"], ["c"]] });
  });

  test("copy and paste shifts formulas and tiles", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "1\t=A1+1");
    const m = buildModel(d.elements());
    d.apply(pasteClipOps(m, "Sheet1", clipOf(m, "Sheet1", { c0: 1, r0: 1, c1: 2, r1: 1 }), { c0: 1, r0: 3, c1: 2, r1: 4 }));
    expect(d.input("c:Sheet1!B3")).toBe("=A3+1");
    expect(d.input("c:Sheet1!B4")).toBe("=A4+1");
  });

  test("conditional colors, tables, query tabs, range read verb", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "x\n1\n-1");
    d.verb("cond", ["A2:A3", "sign"]);
    d.verb("cond", ["A2:A3", "gt", "0", "green"]);
    d.verb("table", ["A1:A3", "green"]);
    const m = buildModel(d.elements());
    // Rules stack on one range; repeating a rule with the same value restyles it.
    expect(m.conds).toHaveLength(2);
    d.verb("cond", ["A2:A3", "gt", "0", "blue"]);
    const conds = buildModel(d.elements()).conds;
    expect(conds).toHaveLength(2);
    expect(conds.find((c) => c.rule === "gt")).toMatchObject({ value: 0, color: "blue" });
    d.verb("cond", ["A2:A3", "clear"]);
    expect(buildModel(d.elements()).conds).toHaveLength(0);
    expect(m.tables[0]).toMatchObject({ color: "green", banded: true });
    d.verb("query", ["Open tasks", "tasks", "project=codecast"]);
    expect(buildModel(d.elements()).tabs.find((t) => t.name === "Open tasks")?.query).toEqual({ source: "tasks", project: "codecast" });
    expect(sheetSpec.verbs!.range.run(d.view(), ["A1:A3"]).status).toBe("x\n1\n-1");
    expect(() => d.verb("fmt", ["A1", "fill=pink"])).toThrow(/color must be/);
  });

  test("structuralOps on a tab with widths moves widths", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("width", ["Sheet1!B", "200"]);
    d.apply(structuralOps(buildModel(d.elements()), "Sheet1", "col", 1, 1));
    expect(d.state.get("col:Sheet1!C")?.fields.w).toBe(200);
    expect(d.state.get("col:Sheet1!B")?.deleted).toBe(true);
  });
});

describe("query tabs", () => {
  test("fill, diff, size columns, clear leftovers", async () => {
    const { queryTabOps } = await import("./ops");
    const d = doc(sheetSpec.seed!());
    d.verb("query", ["Open tasks", "tasks"]);
    const tabId = buildModel(d.elements()).tabs.find((t) => t.name === "Open tasks")!.id;
    d.apply(queryTabOps(buildModel(d.elements()), tabId, [["ID", "Title"], ["ct-1", "A long task title here"], ["ct-2", "B"]], 1000));
    expect(d.state.get(`c:${tabId}!A1`)?.fields).toEqual({ input: "ID", b: true });
    expect(d.state.get(`col:${tabId}!B`)?.fields.w).toBe(Math.round(22 * 7.6 + 22));
    const again = queryTabOps(buildModel(d.elements()), tabId, [["ID", "Title"], ["ct-1", "A long task title here"]], 2000);
    // Only row 3 clears and the stamp moves; nothing else rewrites.
    expect(again.map((o) => o.k).sort()).toEqual([`c:${tabId}!A3`, `c:${tabId}!B3`, `tab:${tabId}`].sort());
    d.apply(again);
    expect(buildModel(d.elements()).byId.get(tabId)!.meta.refreshedAt).toBe(2000);
  });
});

describe("review fixes: ops", () => {
  test("cut and paste moves cells and the references that point at them", async () => {
    const { moveOps } = await import("./ops");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "5\t=A1*2\n\t\nx\t=SUM(A1:A1)");
    d.verb("write", ["Other!A1"], "=Sheet1!A1+1");
    d.apply(moveOps(buildModel(d.elements()), "Sheet1", { c0: 1, r0: 1, c1: 1, r1: 1 }, 1, 2));
    expect(d.input("c:Sheet1!A1")).toBeUndefined();
    expect(d.input("c:Sheet1!A2")).toBe("5");
    expect(d.input("c:Sheet1!B1")).toBe("=A2*2");
    expect(d.input("c:Sheet1!B3")).toBe("=SUM(A2:A2)");
    expect(d.input("c:t1!A1")).toBe("=Sheet1!A2+1");
    expect(readSheetRange(d.elements(), "B1")).toMatchObject({ values: [[10]] });
  });
  test("a moved block keeps its internal references pointing inside it", async () => {
    const { moveOps } = await import("./ops");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "2\t=A1*3");
    d.apply(moveOps(buildModel(d.elements()), "Sheet1", { c0: 1, r0: 1, c1: 2, r1: 1 }, 3, 5));
    expect(d.input("c:Sheet1!D5")).toBe("=C5*3");
    expect(d.input("c:Sheet1!A1")).toBeUndefined();
    expect(readSheetRange(d.elements(), "D5")).toMatchObject({ values: [[6]] });
  });
  test("column insert moves the filter block and its hidden values; frozen counts follow", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "h\tk\nx\t1");
    d.apply([{ k: "tab:Sheet1", put: { kind: "tab", name: "Sheet1", order: 0, frozen_rows: 1, frozen_cols: 2, filter: { row: 1, c0: 1, c1: 2, hidden: { "2": ["1"] } } } }]);
    d.apply(structuralOps(buildModel(d.elements()), "Sheet1", "col", 2, 1));
    const meta = buildModel(d.elements()).byId.get("Sheet1")!.meta;
    expect(meta.filter).toEqual({ row: 1, c0: 1, c1: 3, hidden: { "3": ["1"] } });
    expect(meta.frozenCols).toBe(3);
    d.apply(structuralOps(buildModel(d.elements()), "Sheet1", "row", 1, -1));
    expect(buildModel(d.elements()).byId.get("Sheet1")!.meta.frozenRows).toBe(0);
  });
  test("a percent series continues as percents", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "10%\n20%");
    d.apply(fillOps(buildModel(d.elements()), "Sheet1", { c0: 1, r0: 1, c1: 1, r1: 2 }, { c0: 1, r0: 1, c1: 1, r1: 3 }));
    expect(d.state.get("c:Sheet1!A3")?.fields).toMatchObject({ input: "0.3", nf: "percent", dp: 0 });
  });
  test("a clip of visible rows skips filtered-out rows", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "a\nb\nc");
    const clip = clipOf(buildModel(d.elements()), "Sheet1", { c0: 1, r0: 1, c1: 1, r1: 3 }, [1, 3]);
    expect(clip.cells.map((r) => r[0]?.input)).toEqual(["a", "c"]);
  });
});

describe("round 3 fixes: ops", () => {
  test("cut to another tab is a move: dependents follow, moved formulas keep their sources", async () => {
    const { moveOps } = await import("./ops");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "5\t=A1*2\n7");
    d.verb("write", ["Other!C1"], "x");
    d.verb("write", ["A3"], "=A1+A2");
    d.apply(moveOps(buildModel(d.elements()), "Sheet1", { c0: 1, r0: 3, c1: 1, r1: 3 }, 2, 2, "t1"));
    expect(d.input("c:t1!B2")).toBe("=Sheet1!A1+Sheet1!A2");
    d.apply(moveOps(buildModel(d.elements()), "Sheet1", { c0: 1, r0: 1, c1: 1, r1: 1 }, 1, 5, "t1"));
    expect(d.input("c:Sheet1!B1")).toBe("=Other!A5*2");
    expect(d.input("c:t1!B2")).toBe("=A5+Sheet1!A2");
    expect(readSheetRange(d.elements(), "Other!B2")).toMatchObject({ values: [[12]] });
  });
  test("pasting a filtered copy shifts each formula from its own source row", async () => {
    const { clipOf, pasteClipOps } = await import("./ops");
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "1\t=A1\n2\t=A2\n3\t=A3");
    const m = buildModel(d.elements());
    d.apply(pasteClipOps(m, "Sheet1", clipOf(m, "Sheet1", { c0: 2, r0: 1, c1: 2, r1: 3 }, [1, 3]), { c0: 4, r0: 1, c1: 4, r1: 2 }));
    expect(d.input("c:Sheet1!D1")).toBe("=C1");
    expect(d.input("c:Sheet1!D2")).toBe("=C2");
  });
});

describe("lead review fixes", () => {
  test("an agent's write widens the columns it touched, and only those nobody sized", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("width", ["Sheet1!B", "90"]);
    const r = d.verb("write", ["A1"], "Conservative growth over last year\tx\n5\t6");
    const widths = r.ops.filter((o) => o.k.startsWith("col:")).map((o) => o.k);
    expect(widths).toEqual(["col:Sheet1!A"]);
    expect((d.state.get("col:Sheet1!A")?.fields.w as number) > 200).toBe(true);
    expect(d.state.get("col:Sheet1!B")?.fields.w).toBe(90);
  });
  test("fit sizes columns to formatted values; MAX and INDEX keep the number format", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "Q1\tQ2\n12000\t24726\n=MAX(A2:B2)\t=INDEX(A2:B2,1,2)");
    d.verb("fmt", ["A2:B2", "cur"]);
    const text = describeSheet(d.view());
    expect(text).toContain("A3 =MAX(A2:B2) → $24,726.00");
    expect(text).toContain("B3 =INDEX(A2:B2,1,2) → $24,726.00");
    const r = sheetSpec.verbs!.fit.run(d.view(), ["Sheet1!A:B"]);
    expect(r.ops.map((o) => o.k)).toEqual(["col:Sheet1!A", "col:Sheet1!B"]);
  });
  test("a table header keeps a year as typed in the agent's view", () => {
    const d = doc(sheetSpec.seed!());
    d.verb("write", ["A1"], "Channel\t2025\nWeb\t21000");
    d.verb("fmt", ["B1:B2", "num"]);
    d.verb("table", ["A1:B2", "blue"]);
    const text = describeSheet(d.view());
    expect(text).toContain('B1 2025');
    expect(text).toContain("B2 21000");
  });
});
