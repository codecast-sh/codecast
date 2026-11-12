import { describe, expect, test } from "bun:test";
import { foldOps, toElement } from "../core";
import { SHEET_TEMPLATES } from "./templates";
import { buildModel, workbookFor } from "./model";
import { isError } from "./values";
import { formatValue } from "./format";
import { styleOf } from "./model";

describe("sheet templates", () => {
  for (const t of SHEET_TEMPLATES) {
    test(`${t.label} builds a sheet with no errors`, () => {
      const model = buildModel([...foldOps(new Map(), t.ops(new Date(2026, 10, 11, 12)))].map(([k, st]) => toElement(k, st)));
      const wb = workbookFor(model);
      const tab = model.tabs[0];
      expect(model.tabs.length).toBe(1);
      expect(tab.frozenRows).toBe(1);
      for (const n of model.byId.get(tab.id)!.cells.keys()) expect(isError(wb.value(tab.id, n % 32768, Math.floor(n / 32768)))).toBe(false);
    });
  }
  test("budget totals and timesheet hours compute", () => {
    const read = (id: string, col: number, row: number) => {
      const model = buildModel([...foldOps(new Map(), SHEET_TEMPLATES.find((t) => t.id === id)!.ops(new Date(2026, 10, 11, 12)))].map(([k, st]) => toElement(k, st)));
      const tab = model.tabs[0];
      const el = model.byId.get(tab.id)!.cells.get(row * 32768 + col);
      const info = workbookFor(model).cell(tab.id, col, row);
      return formatValue(info?.value ?? null, styleOf(el), info?.implied);
    };
    expect(read("budget", 2, 8)).toBe("$25,800");
    expect(read("timesheet", 6, 2)).toBe("8.00");
    expect(read("timesheet", 6, 7)).toBe("38.00");
    expect(read("timesheet", 2, 2)).toBe("2026-11-09");
  });
});

describe("adding a line to a template", () => {
  test("a row inserted above Budget's Total takes the row above's formats and counts in the total", async () => {
    const { structuralOps, inputOps } = await import("./ops");
    let els: import("../core").ArtifactElement[] = [];
    const all: import("../core").ArtifactOp[] = [...SHEET_TEMPLATES.find((t) => t.id === "budget")!.ops(new Date(2026, 10, 11, 12))];
    const apply = (ops: import("../core").ArtifactOp[]) => {
      all.push(...ops);
      els = [...foldOps(new Map(), all)].filter(([, st]) => !(st as { deleted?: boolean }).deleted).map(([k, st]) => toElement(k, st));
    };
    apply([]);
    let model = buildModel(els);
    const tab = model.tabs[0].id;
    apply(structuralOps(model, tab, "row", 8, 1));
    model = buildModel(els);
    apply(inputOps(model, tab, [{ col: 1, row: 8, input: "Insurance" }, { col: 2, row: 8, input: "500" }, { col: 3, row: 8, input: "600" }]));
    model = buildModel(els);
    const el = model.byId.get(tab)!.cells.get(8 * 32768 + 2);
    expect(el).toMatchObject({ nf: "currency" });
    const info = workbookFor(model).cell(tab, 2, 9);
    expect(formatValue(info?.value ?? null, styleOf(model.byId.get(tab)!.cells.get(9 * 32768 + 2)), info?.implied)).toBe("$26,300");
  });
});
