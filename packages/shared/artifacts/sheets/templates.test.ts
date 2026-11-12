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
