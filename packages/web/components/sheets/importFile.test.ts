import { describe, expect, test } from "bun:test";
import { readXlsx } from "./importFile";

/** A minimal .xlsx: a zip of the given parts, deflated (and one stored, as some writers do). */
function zip(parts: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  Object.entries(parts).forEach(([name, body], i) => {
    const nameB = enc.encode(name);
    const raw = enc.encode(body);
    const stored = i === 0;
    const data = stored ? raw : Bun.deflateSync(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(8, stored ? 0 : 8, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameB.length, true);
    locals.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(10, stored ? 0 : 8, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  });
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(parts).length, true);
  end.setUint16(10, Object.keys(parts).length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...locals, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of all) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

describe("readXlsx", () => {
  test("sheets by name with shared strings, formulas, dates, booleans and gaps", async () => {
    const bytes = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Orders &amp; Co" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Due</t></si><si><r><t>Pie </t></r><r><t xml:space="preserve">&lt;big&gt;</t></r></si><si><t>=not a formula</t></si></sst>`,
      "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="d mmm yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Qty</t></is></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46337</v></c><c r="C2"><v>3</v></c><c r="E2"><f>C2*2</f><v>6</v></c></row>
        <row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" s="2"><v>46338</v></c><c r="C4" t="s"><v>3</v></c></row>
      </sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="B1" t="str"><v>hello</v></c></row></sheetData></worksheet>`,
    });
    const tables = await readXlsx(bytes);
    expect(tables.map((t) => t.name)).toEqual(["Orders & Co", "Notes"]);
    expect(tables[0].grid).toEqual([
      ["Item", "Due", "Qty"],
      ["Pie <big>", "2026-11-11", "3", "", "=C2*2"],
      [],
      ["TRUE", "2026-11-12", "'=not a formula"],
    ]);
    expect(tables[1].grid).toEqual([["", "hello"]]);
  });

  test("shared formulas shift per copy; percent and currency cells keep their type", async () => {
    const bytes = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1"><v>10</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>20</v></c><c r="C1" s="1"><v>0.125</v></c><c r="D1" s="2"><v>1200.5</v></c></row>
        <row r="2"><c r="A2"><v>11</v></c><c r="B2"><f t="shared" si="0"/><v>22</v></c></row>
        <row r="3"><c r="A3"><v>12</v></c><c r="B3"><f t="shared" si="0"/><v>24</v></c></row>
      </sheetData></worksheet>`,
    });
    const [t] = await readXlsx(bytes);
    expect(t.grid).toEqual([
      ["10", "=A1*2", "12.5%", "$1200.5"],
      ["11", "=A2*2"],
      ["12", "=A3*2"],
    ]);
  });

  test("a file that is not a zip says so", async () => {
    await expect(readXlsx(new TextEncoder().encode("name,qty\n"))).rejects.toThrow(/valid .xlsx/);
  });
});

import { keepAsText } from "./importFile";
describe("keepAsText", () => {
  test("leading zeros, long ids and formula-looking text stay text; plain numbers and words don't change", () => {
    expect(keepAsText("02134")).toBe("'02134");
    expect(keepAsText("12345678901234567890")).toBe("'12345678901234567890");
    expect(keepAsText("=1+1")).toBe("'=1+1");
    expect(keepAsText("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(keepAsText("-12.5")).toBe("-12.5");
    expect(keepAsText("120")).toBe("120");
    expect(keepAsText("0")).toBe("0");
    expect(keepAsText("0.5")).toBe("0.5");
    expect(keepAsText("Pecan")).toBe("Pecan");
  });
});

describe("Excel round trip", () => {
  test("styles, merges, dropdowns and array formulas come back", async () => {
    const { LiveSheet, importTablesOps, buildModel } = await import("@codecast/shared/artifacts/sheets");
    const { foldOps, toElement } = await import("@codecast/shared/artifacts");
    const { sheetXlsx } = await import("./exportFile");
    const ops = [
      { k: "tab:S", put: { kind: "tab", name: "Plan", order: 0 } },
      { k: "c:S!A1", put: { kind: "cell", input: "Status", b: true, i: true, u: true, fill: "blue", color: "red", al: "center" } },
      { k: "c:S!B1", put: { kind: "cell", input: "b" } },
      { k: "c:S!B2", put: { kind: "cell", input: "a" } },
      { k: "c:S!C1", put: { kind: "cell", input: "=SORT(B1:B2)" } },
      { k: "c:S!D1", put: { kind: "cell", input: "=ROWS(C1#)" } },
      { k: "c:S!E5", put: { kind: "cell", fill: "yellow" } },
      { k: "c:S!F1", put: { kind: "cell", input: "9:15" } },
      { k: "c:S!F2", put: { kind: "cell", input: "29:45", bd: "tb" } },
      { k: "c:S!F3", put: { kind: "cell", input: "1200.5", nf: "currency", cur: "€", dp: 2 } },
      { k: "c:S!F4", put: { kind: "cell", input: "2026-11-20 14:30" } },
      { k: "c:S!F5", put: { kind: "cell", input: "1234.5", nf: "number", dp: 2 } },
      { k: "c:S!F6", put: { kind: "cell", input: "-42", nf: "accounting", dp: 2 } },
      { k: "c:S!F7", put: { kind: "cell", input: "2026-11-20", nf: "custom", code: "mmm d, yyyy" } },
      { k: "cf1", put: { kind: "cf", tab: "S", range: "B1:B9", rule: "gt", value: 3, color: "red" } },
      { k: "cf2", put: { kind: "cf", tab: "S", range: "C1:C9", rule: "sign" } },
      { k: "cf3", put: { kind: "cf", tab: "S", range: "D1:D9", rule: "between", value: "1, 5", color: "blue" } },
      { k: "cf4", put: { kind: "cf", tab: "S", range: "A1:A9", rule: "contains", value: "Stat", color: "green" } },
      { k: "cf5", put: { kind: "cf", tab: "S", range: "E1:E9", rule: "empty", color: "orange" } },
      { k: "cf6", put: { kind: "cf", tab: "S", range: "G1:G9", rule: "formula", value: '=$A1="x"', color: "violet" } },
      { k: "dv2", put: { kind: "dv", tab: "S", range: "H2:H9", rule: "date" } },
      { k: "mg1", put: { kind: "merge", tab: "S", range: "A3:B4" } },
      { k: "dv1", put: { kind: "dv", tab: "S", range: "A2:A9", rule: "list", options: [{ v: "Open" }, { v: "Done" }], strict: true } },
    ];
    const live = new LiveSheet();
    live.update([...foldOps(new Map(), ops as never)].map(([k, st]) => toElement(k, st)) as never);
    const [table] = await readXlsx(sheetXlsx(live.model, live.wb));
    expect(table.grid[0].slice(0, 4)).toEqual(["Status", "b", "=SORT(B1:B2)", "=ROWS(C1#)"]);
    expect(table.grid[1].slice(0, 2)).toEqual(["", "a"]);
    const back = importTablesOps(buildModel([]), [table]);
    const model = buildModel([...foldOps(new Map(), back.ops)].map(([k, st]) => toElement(k, st)));
    const tab = model.byId.get(back.tabIds[0])!;
    expect(tab.cells.get(1 * 32768 + 1)).toMatchObject({ input: "Status", b: true, i: true, u: true, fill: "blue", color: "red", al: "center" });
    expect(tab.cells.get(5 * 32768 + 5)).toMatchObject({ fill: "yellow" });
    expect(model.merges.map((m) => m.rect)).toEqual([{ c0: 1, r0: 3, c1: 2, r1: 4 }]);
    const f = (r: number) => tab.cells.get(r * 32768 + 6);
    expect(f(1)).toMatchObject({ input: "9:15:00" });
    expect(f(2)).toMatchObject({ input: "29:45:00", bd: "tb" });
    expect(f(3)).toMatchObject({ input: "€1200.5", nf: "currency", cur: "€", dp: 2 });
    expect(f(4)?.input).toBe("2026-11-20 14:30:00");
    expect(f(5)).toMatchObject({ input: "1234.5", nf: "number", dp: 2 });
    expect(f(6)).toMatchObject({ nf: "accounting", dp: 2 });
    expect(f(7)).toMatchObject({ input: "2026-11-20", nf: "custom", code: "mmm d, yyyy" });
    const rules = model.conds.map((c) => [c.rule, c.value ?? null, c.color ?? null]);
    expect(rules).toEqual(expect.arrayContaining([["gt", 3, "red"], ["sign", null, null], ["between", "1, 5", "blue"], ["contains", "Stat", "green"], ["empty", null, "orange"], ["formula", '=$A1="x"', "violet"]]));
    expect(model.validations.map((v) => v.rule).sort()).toEqual(["date", "list"]);
    expect(model.validations.find((v) => v.rule === "list")).toMatchObject({ rule: "list", strict: true, options: [{ v: "Open" }, { v: "Done" }] });
  });
});
