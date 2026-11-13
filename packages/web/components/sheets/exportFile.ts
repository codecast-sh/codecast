// Downloads: one tab (or the selection) as CSV, the whole sheet as an Excel
// workbook. The .xlsx keeps every tab, formulas with their computed values,
// bold, and date cells as real dates. Written without a dependency: an .xlsx
// is a zip of XML parts, stored uncompressed here.
import type { MutableRefObject } from "react";
import { a1, betweenOf, cellNum, displayFormat, formatValue, isError, rectA1, styleOf, type Rect, type SheetModel, type Workbook } from "./sheetCore";
import type { LiveExport } from "../live/registry";
import type { SheetState } from "./sheetActions";

/** What the shell's download menu offers for a sheet, read from the live state when chosen. */
export function sheetExports(S: MutableRefObject<SheetState>): LiveExport[] {
  return [
    {
      format: "csv",
      label: "CSV, this tab",
      selectionAware: true,
      run: async ({ selection }) => {
        const { model, wb, activeTabId, rect } = S.current;
        const many = rect.c0 !== rect.c1 || rect.r0 !== rect.r1;
        return new Blob([sheetCsv(model, wb, activeTabId, selection.length && many ? rect : undefined)], { type: "text/csv" });
      },
    },
    {
      format: "pdf",
      label: "PDF, this tab (to print)",
      run: async () => {
        const { model, wb, activeTabId } = S.current;
        const { sheetPdf } = await import("./pdfExport");
        return new Blob([sheetPdf(model, wb, activeTabId) as BlobPart], { type: "application/pdf" });
      },
    },
    {
      format: "xlsx",
      label: "Excel, every tab",
      run: async () => {
        const { model, wb } = S.current;
        return new Blob([sheetXlsx(model, wb) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      },
    },
  ];
}

const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A tab's cells (or a rectangle of them) as CSV, each value as it shows in the grid. */
/** A cell's text as the grid shows it: a formula without its own format takes the one of what it reads. */
export function shownText(model: SheetModel, wb: Workbook, tabId: string, col: number, row: number): string {
  const info = wb.cell(tabId, col, row);
  if (!info) return "";
  const el = model.byId.get(tabId)?.cells.get(cellNum(col, row));
  return formatValue(info.value, styleOf(el), el?.nf ? info.implied : displayFormat(model, wb, tabId, col, row));
}

export function sheetCsv(model: SheetModel, wb: Workbook, tabId: string, rect?: Rect): string {
  const t = model.byId.get(tabId);
  if (!t) return "";
  const r = rect ?? { c0: 1, r0: 1, c1: Math.max(1, t.cols), r1: Math.max(1, t.rows) };
  const lines: string[] = [];
  for (let row = r.r0; row <= Math.min(r.r1, Math.max(t.rows, r.r0)); row++) {
    const out: string[] = [];
    for (let col = r.c0; col <= Math.min(r.c1, Math.max(t.cols, r.c0)); col++) {
      out.push(csvField(shownText(model, wb, tabId, col, row)));
    }
    lines.push(out.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Functions Excel added after 2007 are stored with a prefix in the file
 * (_xlfn.XLOOKUP, and _xlfn._xlws.FILTER / SORT for the dynamic-array ones);
 * without it Excel shows #NAME?. Strings in the formula are left alone.
 */
const XLFN = ["XLOOKUP", "XMATCH", "UNIQUE", "SEQUENCE", "SORTBY", "IFS", "SWITCH", "TEXTJOIN", "CONCAT", "MAXIFS", "MINIFS", "IFNA", "DAYS", "STDEV.S", "ISOWEEKNUM", "VSTACK", "HSTACK", "TAKE", "DROP", "CHOOSECOLS", "CHOOSEROWS", "TOCOL", "TOROW", "TEXTSPLIT", "LET", "LAMBDA", "RANDARRAY", "FORECAST.LINEAR", "PERCENTILE.INC", "REGEXEXTRACT", "REGEXREPLACE", "REGEXTEST", "FORMULATEXT"];
const XLWS = ["FILTER", "SORT"];
export function excelFormula(f: string): string {
  return f
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\b([A-Z][A-Z0-9.]*)(?=\s*\()/g, (name) => (XLWS.includes(name) ? `_xlfn._xlws.${name}` : XLFN.includes(name) ? `_xlfn.${name}` : name))
            // E1# (a spilled block) is ANCHORARRAY(E1) in the file.
            .replace(/((?:'[^']*'|[A-Za-z0-9_.]+)!)?(\$?[A-Z]{1,3}\$?\d+)#/g, (_m, tab: string | undefined, cell: string) => `_xlfn.ANCHORARRAY(${tab ?? ""}${cell})`),
    )
    .join("");
}

/** The palette as Excel colors (ARGB): fills are a light tint, text the full color. */
export const PALETTE_HEX: Record<string, { fill: string; text: string }> = {
  red: { fill: "FFF4CCCC", text: "FFDC322F" },
  orange: { fill: "FFFCE5CD", text: "FFCB4B16" },
  yellow: { fill: "FFFFF2CC", text: "FFB58900" },
  green: { fill: "FFD9EAD3", text: "FF859900" },
  cyan: { fill: "FFD0E8EA", text: "FF2AA198" },
  blue: { fill: "FFCFE2F3", text: "FF268BD2" },
  violet: { fill: "FFD9D2E9", text: "FF6C71C4" },
  magenta: { fill: "FFEAD1DC", text: "FFD33682" },
  gray: { fill: "FFEEEEEE", text: "FF657B83" },
};

/** The workbook's cell styles, made as cells ask for them: bold, text color, fill and date, in any mix. */
class XlsxStyles {
  private fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  private fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  private xfs = ['<xf numFmtId="0" fontId="0" fillId="0"/>'];
  private ids = new Map<string, number>([["", 0]]);
  private fontIds = new Map<string, number>([["", 0]]);
  private fillIds = new Map<string, number>([["", 0]]);
  private borders = ["<border/>"];
  private borderIds = new Map<string, number>([["", 0]]);

  private numFmts: string[] = [];
  private numFmtIds = new Map<string, number>();

  /** An Excel number format id for a cell's format: built-ins where they match, custom codes (164+) otherwise. */
  fmtId(fmt: { nf?: string; dp?: number; cur?: string; code?: string } | undefined, date: boolean): number {
    if (date && fmt?.nf !== "datetime" && fmt?.nf !== "custom") return 14;
    const nf = fmt?.nf;
    if (!nf || nf === "plain" || nf === "text" || nf === "check") return 0;
    const dp = fmt?.dp;
    const dec = (n: number) => (n > 0 ? "." + "0".repeat(n) : "");
    const cur = (fmt?.cur ?? "$").trim();
    const code =
      nf === "number" ? `#,##0${dec(dp ?? 0)}`
      : nf === "percent" ? `0${dec(dp ?? 0)}%`
      : nf === "currency" ? `"${cur}"#,##0${dec(dp ?? 2)}`
      : nf === "accounting" ? `"${cur}"#,##0${dec(dp ?? 2)};("${cur}"#,##0${dec(dp ?? 2)})`
      : nf === "scientific" ? `0${dec(dp ?? 2)}E+00`
      : nf === "custom" ? (fmt?.code ?? "General")
      : nf === "datetime" ? "yyyy-mm-dd hh:mm"
      : nf === "time" ? "[h]:mm"
      : "";
    if (!code) return 0;
    let id = this.numFmtIds.get(code);
    if (id === undefined) {
      id = 164 + this.numFmts.length;
      this.numFmts.push(`<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`);
      this.numFmtIds.set(code, id);
    }
    return id;
  }

  id(o: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string; fill?: string; date?: boolean; numFmt?: number; align?: string; wrap?: boolean; border?: string; size?: number }): number {
    const numFmt = o.numFmt ?? (o.date ? 14 : 0);
    // Border letters in Excel's order (left, right, top, bottom), so "tb" and "bt" are one border.
    const bd = [..."lrtb"].filter((x) => o.border?.includes(x)).join("");
    // The sheet sizes text in px; Excel in points (13px is about 10pt; unset stays Excel's 11).
    const pt = o.size ? Math.round(o.size * 0.75 * 2) / 2 : 11;
    if (!o.bold && !o.italic && !o.underline && !o.color && !o.fill && !numFmt && !o.align && !o.wrap && !bd && pt === 11) return 0;
    const key = `${o.bold ? "b" : ""}${o.italic ? "i" : ""}${o.underline ? "u" : ""}|${o.color ?? ""}|${o.fill ?? ""}|${numFmt}|${o.align ?? ""}|${o.wrap ? "w" : ""}|${bd}|${pt}`;
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const fontKey = `${o.bold ? "b" : ""}${o.italic ? "i" : ""}${o.underline ? "u" : ""}|${o.color ?? ""}|${pt}`;
    let fontId = this.fontIds.get(fontKey);
    if (fontId === undefined) {
      fontId = this.fonts.length;
      this.fonts.push(`<font>${o.bold ? "<b/>" : ""}${o.italic ? "<i/>" : ""}${o.underline ? "<u/>" : ""}<sz val="${pt}"/>${o.color && PALETTE_HEX[o.color] ? `<color rgb="${PALETTE_HEX[o.color].text}"/>` : ""}<name val="Calibri"/></font>`);
      this.fontIds.set(fontKey, fontId);
    }
    let fillId = this.fillIds.get(o.fill ?? "");
    if (fillId === undefined) {
      fillId = this.fills.length;
      this.fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${PALETTE_HEX[o.fill!]?.fill ?? "FFFFFFFF"}"/></patternFill></fill>`);
      this.fillIds.set(o.fill!, fillId);
    }
    let borderId = this.borderIds.get(bd);
    if (borderId === undefined) {
      borderId = this.borders.length;
      const side = (x: string, tag: string) => (bd.includes(x) ? `<${tag} style="thin"><color auto="1"/></${tag}>` : `<${tag}/>`);
      this.borders.push(`<border>${side("l", "left")}${side("r", "right")}${side("t", "top")}${side("b", "bottom")}<diagonal/></border>`);
      this.borderIds.set(bd, borderId);
    }
    const id = this.xfs.length;
    const alignment = o.align || o.wrap ? `<alignment${o.align ? ` horizontal="${o.align}"` : ""}${o.wrap ? ' wrapText="1"' : ""}/>` : "";
    this.xfs.push(`<xf numFmtId="${numFmt}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}"${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${numFmt ? ' applyNumberFormat="1"' : ""}${alignment ? ' applyAlignment="1">' + alignment + "</xf>" : "/>"}`);
    this.ids.set(key, id);
    return id;
  }

  private dxfs: string[] = [];
  private dxfIds = new Map<string, number>();

  /** A conditional rule's look: a fill tint (with its text color), or the text color alone (gains green, losses red). */
  dxf(color: string, textOnly = false): number {
    const key = `${color}|${textOnly}`;
    let id = this.dxfIds.get(key);
    if (id === undefined) {
      const hex = PALETTE_HEX[color] ?? PALETTE_HEX.yellow;
      id = this.dxfs.length;
      this.dxfs.push(`<dxf><font><color rgb="${hex.text}"/></font>${textOnly ? "" : `<fill><patternFill><bgColor rgb="${hex.fill}"/></patternFill></fill>`}</dxf>`);
      this.dxfIds.set(key, id);
    }
    return id;
  }

  xml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${this.numFmts.length ? `<numFmts count="${this.numFmts.length}">${this.numFmts.join("")}</numFmts>` : ""}<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts><fills count="${this.fills.length}">${this.fills.join("")}</fills><borders count="${this.borders.length}">${this.borders.join("")}</borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs>${this.dxfs.length ? `<dxfs count="${this.dxfs.length}">${this.dxfs.join("")}</dxfs>` : ""}</styleSheet>`;
  }
}

/** A tab's conditional colors as Excel conditional formatting, in the order the sheet applies them. */
function conditionalXml(model: SheetModel, tabId: string, styles: XlsxStyles): string {
  let priority = 1;
  const out: string[] = [];
  for (const c of model.conds) {
    if (c.tab !== tabId) continue;
    const ref = rectA1(c.rect);
    const first = a1(c.rect.c0, c.rect.r0);
    const v = c.value ?? "";
    const lit = (x: string | number) => (typeof x === "number" ? String(x) : `"${String(x).replace(/"/g, '""')}"`);
    const rule = (attrs: string, formula: string, color = c.color ?? "yellow") => `<cfRule ${attrs} dxfId="${styles.dxf(color)}" priority="${priority++}"><formula>${xml(formula)}</formula></cfRule>`;
    let body = "";
    switch (c.rule) {
      case "gt":
      case "lt":
      case "eq":
        body = rule(`type="cellIs" operator="${c.rule === "gt" ? "greaterThan" : c.rule === "lt" ? "lessThan" : "equal"}"`, lit(v));
        break;
      case "ne":
        body = rule(`type="cellIs" operator="notEqual"`, lit(v));
        break;
      case "between": {
        const b = betweenOf(v);
        if (b) body = `<cfRule type="cellIs" operator="between" dxfId="${styles.dxf(c.color ?? "yellow")}" priority="${priority++}"><formula>${b[0]}</formula><formula>${b[1]}</formula></cfRule>`;
        break;
      }
      case "empty":
      case "filled":
        body = rule(`type="${c.rule === "empty" ? "containsBlanks" : "notContainsBlanks"}"`, `${c.rule === "empty" ? "" : "NOT("}LEN(TRIM(${first}))=0${c.rule === "empty" ? "" : ")"}`);
        break;
      case "contains":
        body = `<cfRule type="containsText" operator="containsText" text="${xml(String(v))}" dxfId="${styles.dxf(c.color ?? "yellow")}" priority="${priority++}"><formula>${xml(`NOT(ISERROR(SEARCH(${lit(String(v))},${first})))`)}</formula></cfRule>`;
        break;
      case "before":
      case "after": {
        const when = String(v).trim().toLowerCase() === "today" ? "TODAY()" : `DATEVALUE(${lit(String(v))})`;
        body = rule(`type="expression"`, `AND(ISNUMBER(${first}),${first}${c.rule === "before" ? "<" : ">"}${when})`, c.color ?? "orange");
        break;
      }
      case "formula":
        body = rule(`type="expression"`, excelFormula(String(v).replace(/^=/, "")));
        break;
      case "sign":
        body =
          `<cfRule type="cellIs" operator="greaterThan" dxfId="${styles.dxf("green", true)}" priority="${priority++}"><formula>0</formula></cfRule>` +
          `<cfRule type="cellIs" operator="lessThan" dxfId="${styles.dxf("red", true)}" priority="${priority++}"><formula>0</formula></cfRule>`;
        break;
      case "scale": {
        const hex = PALETTE_HEX[c.color ?? "green"] ?? PALETTE_HEX.green;
        body = `<cfRule type="colorScale" priority="${priority++}"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="${hex.text}"/></colorScale></cfRule>`;
        break;
      }
    }
    if (body) out.push(`<conditionalFormatting sqref="${ref}">${body}</conditionalFormatting>`);
  }
  return out.join("");
}

/** The whole sheet as .xlsx bytes. */
export function sheetXlsx(model: SheetModel, wb: Workbook): Uint8Array {
  const styles = new XlsxStyles();
  const sheets = model.tabs.map((meta, i) => {
    const t = model.byId.get(meta.id)!;
    const byRow = new Map<number, number[]>();
    const add = (col: number, row: number) => {
      const list = byRow.get(row) ?? [];
      list.push(col);
      byRow.set(row, list);
    };
    for (const n of t.cells.keys()) add(n % 32768, Math.floor(n / 32768));
    // A spilled block's values go in too, so Excel shows the array before it recalculates.
    for (const sp of wb.spillRects(meta.id))
      for (let row = sp.r0; row <= sp.r1; row++) for (let col = sp.c0; col <= sp.c1; col++) if (!t.cells.has(cellNum(col, row))) add(col, row);
    const rows = [...byRow.keys()].sort((a, b) => a - b).map((row) => {
      const cells = byRow.get(row)!.sort((a, b) => a - b).map((col) => {
        const el = t.cells.get(cellNum(col, row));
        const info = wb.cell(meta.id, col, row);
        const input = typeof el?.input === "string" ? el.input : "";
        const style = styleOf(el);
        const date = style.nf === "date" || style.nf === "datetime" || info?.implied?.nf === "date" || info?.implied?.nf === "datetime";
        const isDate = date && typeof info?.value === "number";
        // A formula's number takes the format it shows in the grid (its own, else the one it inherits from what it reads).
        const fmt = style.nf ? style : displayFormat(model, wb, meta.id, col, row);
        const s = styles.id({ bold: style.b, italic: style.i, underline: style.u, color: style.color, fill: style.fill, date: isDate, numFmt: typeof info?.value === "number" ? styles.fmtId(fmt, isDate) : 0, align: style.al, wrap: style.wrap, border: style.bd, size: style.fs });
        const ref = a1(col, row);
        const sAttr = s ? ` s="${s}"` : "";
        // An array formula carries the block it fills, as Excel stores one.
        const spill = input.startsWith("=") ? wb.spillRange(meta.id, col, row) : null;
        const f = input.startsWith("=") && input.length > 1 ? `<f${spill ? ` t="array" ref="${rectA1(spill)}"` : ""}>${xml(excelFormula(input.slice(1)))}</f>` : "";
        const v = info?.value ?? null;
        if (v === null || v === "") return f ? `<c r="${ref}"${sAttr}>${f}</c>` : s ? `<c r="${ref}"${sAttr}/>` : "";
        if (typeof v === "number") return `<c r="${ref}"${sAttr}>${f}<v>${v}</v></c>`;
        if (typeof v === "boolean") return `<c r="${ref}" t="b"${sAttr}>${f}<v>${v ? 1 : 0}</v></c>`;
        if (isError(v)) return `<c r="${ref}" t="e"${sAttr}>${f}<v>${xml(v.error)}</v></c>`;
        return f ? `<c r="${ref}" t="str"${sAttr}>${f}<v>${xml(String(v))}</v></c>` : `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
      }).join("");
      return `<row r="${row}">${cells}</row>`;
    }).join("");
    const cols = [...t.colWidths].sort((a, b) => a[0] - b[0]).map(([c, w]) => `<col min="${c}" max="${c}" width="${Math.round((w / 7) * 100) / 100}" customWidth="1"/>`).join("");
    const freeze = meta.frozenRows || meta.frozenCols
      ? `<sheetViews><sheetView workbookViewId="0"><pane ${meta.frozenCols ? `xSplit="${meta.frozenCols}" ` : ""}${meta.frozenRows ? `ySplit="${meta.frozenRows}" ` : ""}topLeftCell="${a1(meta.frozenCols + 1, meta.frozenRows + 1)}" state="frozen"/></sheetView></sheetViews>`
      : "";
    // Dropdowns and date pickers travel as Excel data validation: a list (its values) or any date.
    const dvs = model.validations.filter((v) => v.tab === meta.id).map((v) =>
      v.rule === "list"
        ? `<dataValidation type="list" allowBlank="1" showErrorMessage="${v.strict ? 1 : 0}" sqref="${rectA1(v.rect)}"><formula1>${xml(`"${v.options.map((o) => o.v.replace(/"/g, "'").replace(/,/g, " ")).join(",")}"`)}</formula1></dataValidation>`
        : `<dataValidation type="date" operator="greaterThan" allowBlank="1" showErrorMessage="${v.strict ? 1 : 0}" sqref="${rectA1(v.rect)}"><formula1>1</formula1></dataValidation>`,
    );
    const validation = dvs.length ? `<dataValidations count="${dvs.length}">${dvs.join("")}</dataValidations>` : "";
    const merges = model.merges.filter((m) => m.tab === meta.id);
    const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${rectA1(m.rect)}"/>`).join("")}</mergeCells>` : "";
    return { name: `xl/worksheets/sheet${i + 1}.xml`, body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData>${mergeXml}${conditionalXml(model, meta.id, styles)}${validation}</worksheet>` };
  });
  // Excel caps a sheet name at 31 characters and refuses : \ / ? * [ ].
  const sheetName = (n: string) => n.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";
  const parts: Array<{ name: string; body: string }> = [
    { name: "[Content_Types].xml", body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s) => `<Override PartName="/${s.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${model.tabs.map((t, i) => `<sheet name="${xml(sheetName(t.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.name.slice(3)}"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", body: styles.xml() },
    ...sheets,
  ];
  return zipStored(parts);
}

// ── Zip (stored) ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStored(parts: Array<{ name: string; body: string }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = enc.encode(p.name);
    const data = enc.encode(p.body);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.length, true);
  end.setUint16(10, parts.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
