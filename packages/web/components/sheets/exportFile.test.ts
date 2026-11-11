import { describe, expect, test } from "bun:test";
import { foldOps, toElement, type ArtifactElement, type ArtifactOp } from "@codecast/shared/artifacts";
import { LiveSheet } from "./sheetCore";
import { sheetCsv, sheetXlsx } from "./exportFile";
import { readXlsx } from "./importFile";

function sheet() {
  const ops: ArtifactOp[] = [
    { k: "tab:Sheet1", put: { kind: "tab", name: "Orders", order: 0, frozen_rows: 1 } },
    { k: "tab:t1", put: { kind: "tab", name: "Notes & more", order: 1 } },
    { k: "c:Sheet1!A1", put: { kind: "cell", input: "Flavor", b: true } },
    { k: "c:Sheet1!B1", put: { kind: "cell", input: "Boxes", b: true } },
    { k: "c:Sheet1!C1", put: { kind: "cell", input: "Due" } },
    { k: "c:Sheet1!A2", put: { kind: "cell", input: "Pecan, salted" } },
    { k: "c:Sheet1!B2", put: { kind: "cell", input: "120" } },
    { k: "c:Sheet1!C2", put: { kind: "cell", input: "2026-11-20" } },
    { k: "c:Sheet1!B3", put: { kind: "cell", input: "=B2*2" } },
    { k: "c:t1!A1", put: { kind: "cell", input: "say \"hi\"" } },
    { k: "c:Sheet1!A3", put: { kind: "cell", input: "Late", fill: "red", color: "blue" } },
    { k: "dv_1", put: { kind: "dv", tab: "Sheet1", range: "D2:D9", rule: "list", options: [{ v: "Open" }, { v: "Done", color: "green" }], strict: true } },
  ];
  const live = new LiveSheet();
  live.update([...foldOps(new Map(), ops)].map(([k, s]) => toElement(k, s)) as ArtifactElement[]);
  return live;
}

describe("export", () => {
  test("CSV shows values as the grid does, quoting what needs it", () => {
    const s = sheet();
    expect(sheetCsv(s.model, s.wb, "Sheet1")).toBe('Flavor,Boxes,Due\r\n"Pecan, salted",120,2026-11-20\r\nLate,240,\r\n');
  });

  test("XLSX round-trips through the importer: tabs, formulas, dates", async () => {
    const s = sheet();
    const tables = await readXlsx(sheetXlsx(s.model, s.wb));
    expect(tables.map((t) => t.name)).toEqual(["Orders", "Notes & more"]);
    expect(tables[0].grid).toEqual([
      ["Flavor", "Boxes", "Due"],
      ["Pecan, salted", "120", "2026-11-20"],
      ["Late", "=B2*2"],
    ]);
    expect(tables[1].grid).toEqual([['say "hi"']]);
    const text = new TextDecoder().decode(sheetXlsx(s.model, s.wb));
    expect(text).toContain('<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="D2:D9"><formula1>&quot;Open,Done&quot;</formula1>');
    expect(text).toContain('<fgColor rgb="FFF4CCCC"/>');
    expect(text).toContain('<color rgb="FF268BD2"/>');
  });
});
