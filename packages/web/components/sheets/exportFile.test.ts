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
    { k: "c:Sheet1!B2", put: { kind: "cell", input: "120", nf: "currency", cur: "€" } },
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
    expect(sheetCsv(s.model, s.wb, "Sheet1")).toBe('Flavor,Boxes,Due\r\n"Pecan, salted",€120.00,2026-11-20\r\nLate,€240.00,\r\n');
  });

  test("XLSX round-trips through the importer: tabs, formulas, dates", async () => {
    const s = sheet();
    const tables = await readXlsx(sheetXlsx(s.model, s.wb));
    expect(tables.map((t) => t.name)).toEqual(["Orders", "Notes & more"]);
    expect(tables[0].grid).toEqual([
      ["Flavor", "Boxes", "Due"],
      ["Pecan, salted", "€120", "2026-11-20"],
      ["Late", "=B2*2"],
    ]);
    expect(tables[1].grid).toEqual([['say "hi"']]);
    const text = new TextDecoder().decode(sheetXlsx(s.model, s.wb));
    expect(text).toContain('<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="D2:D9"><formula1>&quot;Open,Done&quot;</formula1>');
    expect(text).toContain('<fgColor rgb="FFF4CCCC"/>');
    expect(text).toContain('<color rgb="FF268BD2"/>');
    expect(text).toContain('<numFmt numFmtId="164" formatCode="&quot;€&quot;#,##0.00"/>');
  });
});

import { excelFormula } from "./exportFile";
describe("Excel function prefixes", () => {
  test("newer functions get Excel's prefix, text inside quotes is untouched, and import strips it", () => {
    expect(excelFormula('SORT(UNIQUE(A2:A9))+XLOOKUP(B1,A:A,C:C)&"SORT(x)"')).toBe('_xlfn._xlws.SORT(_xlfn.UNIQUE(A2:A9))+_xlfn.XLOOKUP(B1,A:A,C:C)&"SORT(x)"');
    expect(excelFormula("SUM(A1:A3)")).toBe("SUM(A1:A3)");
  });
});

describe("conditional colors in Excel", () => {
  test("each rule becomes Excel conditional formatting with a dxf look", () => {
    const ops: ArtifactOp[] = [
      { k: "tab:S", put: { kind: "tab", name: "S", order: 0 } },
      { k: "c:S!A1", put: { kind: "cell", input: "5" } },
      { k: "cf_1", put: { kind: "cf", tab: "S", range: "A1:A9", rule: "gt", value: 3, color: "red" } },
      { k: "cf_2", put: { kind: "cf", tab: "S", range: "B2:D9", rule: "formula", value: '=$B2="Offer"', color: "green" } },
      { k: "cf_3", put: { kind: "cf", tab: "S", range: "C2:C9", rule: "before", value: "today" } },
    ];
    const live = new LiveSheet();
    live.update([...foldOps(new Map(), ops)].map(([k, st]) => toElement(k, st)) as ArtifactElement[]);
    const text = new TextDecoder().decode(sheetXlsx(live.model, live.wb));
    expect(text).toContain('<conditionalFormatting sqref="A1:A9"><cfRule type="cellIs" operator="greaterThan" dxfId="0" priority="1"><formula>3</formula></cfRule></conditionalFormatting>');
    expect(text).toContain('<cfRule type="expression" dxfId="1" priority="2"><formula>$B2=&quot;Offer&quot;</formula></cfRule>');
    expect(text).toContain("<formula>AND(ISNUMBER(C2),C2&lt;TODAY())</formula>");
    expect(text).toContain('<dxfs count="3">');
  });
});

describe("arrays in Excel", () => {
  test("a spill is an array formula with its block's values; E1# is ANCHORARRAY", () => {
    expect(excelFormula("TAKE(VSTACK(A1:A2,B1:B2),1)")).toBe("_xlfn.TAKE(_xlfn.VSTACK(A1:A2,B1:B2),1)");
    expect(excelFormula("ROWS(E1#)+SUM(Data!B2#)")).toBe("ROWS(_xlfn.ANCHORARRAY(E1))+SUM(_xlfn.ANCHORARRAY(Data!B2))");
    const ops: ArtifactOp[] = [
      { k: "tab:S", put: { kind: "tab", name: "S", order: 0 } },
      { k: "c:S!A1", put: { kind: "cell", input: "b" } },
      { k: "c:S!A2", put: { kind: "cell", input: "a" } },
      { k: "c:S!C1", put: { kind: "cell", input: "=SORT(A1:A2)", i: true } },
    ];
    const live = new LiveSheet();
    live.update([...foldOps(new Map(), ops)].map(([k, st]) => toElement(k, st)) as ArtifactElement[]);
    const text = new TextDecoder().decode(sheetXlsx(live.model, live.wb));
    expect(text).toContain('<f t="array" ref="C1:C2">_xlfn._xlws.SORT(A1:A2)</f><v>a</v>');
    expect(text).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">b</t></is></c>');
    expect(text).toContain("<i/>");
  });
});
