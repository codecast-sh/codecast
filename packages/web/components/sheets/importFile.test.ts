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

  test("a file that is not a zip says so", async () => {
    await expect(readXlsx(new TextEncoder().encode("name,qty\n"))).rejects.toThrow(/valid .xlsx/);
  });
});
