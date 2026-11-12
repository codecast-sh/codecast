// Reading a dropped or picked file into tables of cell inputs: CSV / TSV
// text, or an Excel workbook (.xlsx, one table per worksheet, with formulas,
// shared strings and date formats). No dependency: an .xlsx is a zip of XML,
// read here with the browser's DecompressionStream.
import { parseRectA1, parseTable, serialToDate, shiftFormula, type CellStyle, type CondRule, type ImportTable, type PaletteColor, type Rect } from "@codecast/shared/artifacts/sheets";
import { PALETTE_HEX } from "./exportFile";

export type ImportedTable = ImportTable;

/** Files the importer reads, for an <input accept>. */
export const IMPORT_ACCEPT = ".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_ROWS = 50_000;

export async function readSheetFile(file: File): Promise<ImportedTable[]> {
  const base = file.name.replace(/\.[^.]+$/, "") || "Imported";
  if (/\.xlsx$/i.test(file.name) || file.type.includes("spreadsheetml")) {
    const tables = await readXlsx(new Uint8Array(await file.arrayBuffer()));
    // A one-sheet workbook with a default sheet name ("Sheet1") reads better named after its file.
    return tables.length === 1 && /^(sheet|feuil|tabelle|hoja)\s*\d+$/i.test(tables[0].name) ? [{ ...tables[0], name: base }] : tables;
  }
  if (/\.xls$/i.test(file.name)) throw new Error("Old .xls files can't be read. Save it as .xlsx or .csv");
  return [{ name: base, grid: parseTable(await file.text()).slice(0, MAX_ROWS).map((row) => row.map(keepAsText)) }];
}

/**
 * A value from a file that should stay exactly as written: zip codes and ids
 * with leading zeros (02134), digit strings too long for a number (card or
 * order ids), and anything starting with "=" (a CSV is data; running its
 * formulas would let a file compute against the sheet). Marked as text the
 * way a person types it: a leading apostrophe.
 */
export function keepAsText(v: string): string {
  const t = v.trim();
  if (/^0\d+$/.test(t) || /^\d{16,}$/.test(t) || /^[=+@]/.test(t) || (t.startsWith("-") && /^-[^\d.]/.test(t))) return `'${v}`;
  return v;
}

// ── Zip ─────────────────────────────────────────────────────────────────────

async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This file isn't a valid .xlsx");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflate(raw));
  }
  return out;
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── Workbook XML ────────────────────────────────────────────────────────────

const unescape = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
/** All text runs of a string item (<si>), joined: rich text keeps its words. */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");

/** Built-in Excel number formats: dates (14 to 22, 45 to 47), percents (9, 10), currency (5 to 8, 44). */
const DATE_FMT_IDS = new Set([14, 15, 16, 17]);
const TIME_FMT_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
const DATETIME_FMT_IDS = new Set([22]);
/** Excel's built-in number formats the sheet has a format for. */
const BUILTIN_FORMATS: Record<number, CellStyle> = {
  2: { nf: "number", dp: 2 },
  3: { nf: "number", dp: 0 },
  4: { nf: "number", dp: 2 },
  10: { nf: "percent", dp: 2 },
  11: { nf: "scientific", dp: 2 },
  48: { nf: "scientific", dp: 1 },
  49: { nf: "text" },
};
const PERCENT_FMT_IDS = new Set([9, 10]);
const CURRENCY_FMT_IDS = new Set([5, 6, 7, 8, 44]);

type CellKind = "date" | "time" | "datetime" | "percent" | "currency";

/** What each cell style shows a number as, so an import types it the same way ("12%", "$1,200", a date). */
type Styles = Map<number, CellKind> & { symbols?: Map<number, string>; looks?: Map<number, CellStyle> };

/** The palette color nearest an Excel ARGB, among fills or text colors; none for the defaults (white fill, black text). */
export function snapColor(argb: string | undefined, as: "fill" | "text"): PaletteColor | undefined {
  if (!argb || argb.length < 6) return undefined;
  const rgb = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(-6).slice(i, i + 2), 16));
  const [r, g, b] = rgb(argb);
  if (as === "fill" ? r + g + b > 750 : r + g + b < 120) return undefined;
  let best: PaletteColor | undefined;
  let bestD = Infinity;
  for (const [name, hex] of Object.entries(PALETTE_HEX)) {
    const [pr, pg, pb] = rgb(hex[as]);
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) [best, bestD] = [name as PaletteColor, d];
  }
  return best;
}

/** How each cell style looks: bold, italic, underline, colors snapped to the sheet's palette, alignment and wrap. */
function styleLooks(stylesXml: string, xfs: string[]): Map<number, CellStyle> {
  const section = (tag: string) => [...(stylesXml.match(new RegExp(`<${tag}s[^>]*>([\\s\\S]*?)</${tag}s>`))?.[1] ?? "").matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"))].map((m) => m[0]);
  const fonts = section("font");
  const fills = section("fill");
  const borders = section("border");
  const looks = new Map<number, CellStyle>();
  xfs.forEach((xf, i) => {
    const style: CellStyle = {};
    const font = fonts[Number(attr(xf, "fontId") ?? 0)] ?? "";
    if (/<b(?:\s+val="(?:1|true)")?\s*\/>/.test(font)) style.b = true;
    if (/<i(?:\s+val="(?:1|true)")?\s*\/>/.test(font)) style.i = true;
    if (/<u(?:\s+val="(?!none)[^"]*")?\s*\/>/.test(font)) style.u = true;
    const color = snapColor(attr(font.match(/<color\s[^>]*>/)?.[0] ?? "", "rgb"), "text");
    if (color) style.color = color;
    const fill = fills[Number(attr(xf, "fillId") ?? 0)] ?? "";
    if (/patternType="solid"/.test(fill)) {
      const bg = snapColor(attr(fill.match(/<fgColor\s[^>]*>/)?.[0] ?? "", "rgb"), "fill");
      if (bg) style.fill = bg;
    }
    const border = borders[Number(attr(xf, "borderId") ?? 0)] ?? "";
    const bd = [["t", "top"], ["r", "right"], ["b", "bottom"], ["l", "left"]].filter(([, side]) => new RegExp(`<${side}\\s[^>]*style="`).test(border)).map(([x]) => x).join("");
    if (bd) style.bd = bd;
    const align = xf.match(/<alignment\s[^>]*>/)?.[0] ?? "";
    const al = attr(align, "horizontal");
    if (al === "left" || al === "center" || al === "right") style.al = al;
    if (/wrapText="(?:1|true)"/.test(align)) style.wrap = true;
    if (Object.keys(style).length) looks.set(i, style);
  });
  return looks;
}

function styleKinds(stylesXml: string | undefined): Styles {
  const out: Styles = new Map<number, CellKind>();
  out.symbols = new Map();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(m[0], "numFmtId")), unescape(attr(m[0], "formatCode") ?? ""));
  const xfList = [...(stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "").matchAll(/<xf\s[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
  out.looks = styleLooks(stylesXml, xfList);
  xfList.forEach((xf, i) => {
    const id = Number(attr(xf, "numFmtId") ?? 0);
    const code = custom.get(id);
    // Letters outside quotes and brackets say what a custom code shows; [h] (elapsed hours) is a duration.
    const bare = code?.replace(/"[^"]*"|\[[^\]]*\]/g, "") ?? "";
    const hasTime = !!code && (/[hs]/i.test(bare) || /\[[hms]+\]/i.test(code));
    const hasDate = !!code && (/[dy]/i.test(bare) || /m{3,}/i.test(bare) || (/m/i.test(bare) && !hasTime));
    const dp = (code?.split(";")[0].match(/\.(0+)/)?.[1].length) ?? 0;
    const look = (f: CellStyle) => out.looks!.set(i, { ...out.looks!.get(i), ...f });
    if (DATETIME_FMT_IDS.has(id) || (hasTime && hasDate)) {
      out.set(i, "datetime");
      if (code) look({ nf: "custom", code });
    } else if (TIME_FMT_IDS.has(id) || hasTime) {
      out.set(i, "time");
      // Elapsed time and plain h:mm read as the sheet's time format; a code with AM/PM or seconds keeps its code.
      if (code && !/^\[?h\]?:mm$/i.test(code.trim())) look({ nf: "custom", code });
    } else if (DATE_FMT_IDS.has(id) || hasDate) {
      out.set(i, "date");
      if (code && !/^y{2,4}-m{1,2}-d{1,2}$/i.test(code.trim())) look({ nf: "custom", code });
    } else if (PERCENT_FMT_IDS.has(id) || bare.includes("%")) {
      out.set(i, "percent");
      if (code || id === 10) look({ nf: "percent", dp: code ? dp : 2 });
    } else if (CURRENCY_FMT_IDS.has(id) || /[$€£¥₹]/.test(code ?? "")) {
      out.set(i, "currency");
      // The symbol the format shows ("€" in "€"#,##0.00), so the import reads as the same money.
      const sym = code?.match(/[$€£¥₹]/)?.[0];
      if (sym) out.symbols!.set(i, sym);
      // Negatives in parentheses, or Excel's aligned accounting layout (_( and * ), read as accounting.
      const accounting = !!code && (/;\s*\(/.test(code) || /_\(|\*\s/.test(code)) || id === 44;
      look({ nf: accounting ? "accounting" : "currency", dp: code ? dp : id === 7 || id === 8 || id === 44 ? 2 : 0, ...(sym && sym !== "$" ? { cur: sym } : {}) });
    } else if (BUILTIN_FORMATS[id]) look(BUILTIN_FORMATS[id]);
    else if (code && /E\+/i.test(bare)) look({ nf: "scientific", dp });
    else if (code && /^[#,0.]+$/.test(code.trim())) look({ nf: "number", dp });
    else if (code && code !== "General") look({ nf: "custom", code });
  });
  return out;
}

/** Each conditional style (dxf) as a palette color: its fill, else its text color (textOnly). */
function dxfLooks(stylesXml: string | undefined): Array<{ color?: PaletteColor; textOnly: boolean }> {
  const block = stylesXml?.match(/<dxfs[^>]*>([\s\S]*?)<\/dxfs>/)?.[1] ?? "";
  return [...block.matchAll(/<dxf>([\s\S]*?)<\/dxf>/g)].map((m) => {
    const fill = snapColor(attr(m[1].match(/<bgColor\s[^>]*>/)?.[0] ?? "", "rgb"), "fill");
    if (fill) return { color: fill, textOnly: false };
    return { color: snapColor(attr(m[1].match(/<font>[\s\S]*?<color\s[^>]*>/)?.[0].match(/<color\s[^>]*>/)?.[0] ?? "", "rgb"), "text"), textOnly: true };
  });
}

/** A sheet's conditional formatting as the sheet's own rules, the ones it can show (cell comparisons, text, blanks, formulas, color scales). */
function condsOf(xml: string, dxfs: Array<{ color?: PaletteColor; textOnly: boolean }>): NonNullable<ImportTable["conds"]> {
  const out: NonNullable<ImportTable["conds"]> = [];
  const literal = (f: string | undefined): string | number | undefined => {
    if (f === undefined) return undefined;
    const t = unescape(f).trim();
    const q = t.match(/^"((?:[^"]|"")*)"$/);
    if (q) return q[1].replace(/""/g, '"');
    return Number.isFinite(Number(t)) && t !== "" ? Number(t) : t;
  };
  for (const block of xml.matchAll(/<conditionalFormatting\s([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
    const rects = (attr(` ${block[1]}`, "sqref") ?? "").split(/\s+/).map(parseRectA1).filter((r): r is Rect => !!r);
    const rules = [...block[2].matchAll(/<cfRule\s([^>]*)>([\s\S]*?)<\/cfRule>/g)].map((r) => {
      const head = ` ${r[1]}`;
      const look = dxfs[Number(attr(head, "dxfId") ?? -1)];
      return { type: attr(head, "type"), op: attr(head, "operator"), text: attr(head, "text"), formulas: [...r[2].matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map((f) => f[1]), body: r[2], look };
    });
    const found: Array<{ rule: CondRule; value?: string | number; color?: string }> = [];
    // Green text above 0 and red text below 0 is the sheet's gains-and-losses rule.
    const above = rules.find((r) => r.type === "cellIs" && r.op === "greaterThan" && r.formulas[0] === "0" && r.look?.textOnly);
    const below = rules.find((r) => r.type === "cellIs" && r.op === "lessThan" && r.formulas[0] === "0" && r.look?.textOnly);
    if (above && below) found.push({ rule: "sign" });
    for (const r of rules) {
      if (above && below && (r === above || r === below)) continue;
      const color = r.look?.color;
      const ops: Record<string, CondRule> = { greaterThan: "gt", lessThan: "lt", equal: "eq", notEqual: "ne" };
      if (r.type === "cellIs" && r.op === "between" && r.formulas.length === 2) found.push({ rule: "between", value: `${literal(r.formulas[0])}, ${literal(r.formulas[1])}`, color });
      else if (r.type === "cellIs" && r.op && ops[r.op]) found.push({ rule: ops[r.op], value: literal(r.formulas[0]), color });
      else if (r.type === "containsText" && r.text !== undefined) found.push({ rule: "contains", value: unescape(r.text), color });
      else if (r.type === "containsBlanks") found.push({ rule: "empty", color });
      else if (r.type === "notContainsBlanks") found.push({ rule: "filled", color });
      else if (r.type === "colorScale") found.push({ rule: "scale", color: snapColor([...r.body.matchAll(/<color\s([^>]*)>/g)].map((c) => attr(` ${c[1]}`, "rgb")).pop(), "text") });
      else if (r.type === "expression" && r.formulas[0]) found.push({ rule: "formula", value: `=${unescape(r.formulas[0]).replace(/_xlfn\.(?:_xlws\.)?/gi, "")}`, color });
    }
    for (const rect of rects) for (const f of found) out.push({ rect, ...f });
  }
  return out;
}

function colIndexOf(ref: string): number {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)?.[0] ?? "A") n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export async function readXlsx(bytes: Uint8Array): Promise<ImportedTable[]> {
  const files = await unzip(bytes);
  const text = (name: string) => {
    const b = files.get(name);
    return b ? new TextDecoder().decode(b) : undefined;
  };
  const wb = text("xl/workbook.xml");
  if (!wb) throw new Error("This file isn't a valid .xlsx");
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const kinds = styleKinds(text("xl/styles.xml"));
  const dxfs = dxfLooks(text("xl/styles.xml"));
  // Sheet name -> part path, through the workbook's relationships.
  const rels = new Map<string, string>();
  for (const m of (text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
    const target = attr(m[0], "Target") ?? "";
    rels.set(attr(m[0], "Id") ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const tables: ImportedTable[] = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = unescape(attr(m[0], "name") ?? `Sheet${tables.length + 1}`);
    const xml = text(rels.get(attr(m[0], "r:id") ?? "") ?? "");
    if (!xml) continue;
    const grid: string[][] = [];
    const styles: NonNullable<ImportTable["styles"]> = [];
    /** Blocks an array formula fills: Excel writes their values as cells, which the sheet recomputes instead. */
    const arrays: Rect[] = [];
    /** Shared formulas: Excel writes the first of a run in full and the rest by its id; each copy shifts from the first. */
    const sharedF = new Map<string, { text: string; col: number; row: number }>();
    for (const c of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = ` ${c[1]}`;
      const ref = attr(tag, "r");
      if (!ref) continue;
      const row = Number(ref.match(/\d+$/)?.[0]);
      if (!row || row > MAX_ROWS) continue;
      const col = colIndexOf(ref);
      const look = kinds.looks?.get(Number(attr(tag, "s") ?? 0));
      if (look) styles.push({ col, row, style: look });
      if (arrays.some((a) => col >= a.c0 && col <= a.c1 && row >= a.r0 && row <= a.r1)) continue;
      const body = c[2] ?? "";
      const type = attr(tag, "t");
      const fTag = body.match(/<f(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/f>)/);
      const si = fTag ? attr(` ${fTag[1] ?? ""}`, "si") : undefined;
      const arrayRef = fTag && attr(` ${fTag[1] ?? ""}`, "t") === "array" ? parseRectA1(attr(` ${fTag[1] ?? ""}`, "ref") ?? "") : null;
      // The anchor (this cell) keeps the formula; the rest of its block is skipped above.
      if (arrayRef) arrays.push(arrayRef);
      // Excel stores newer functions with a prefix (_xlfn.XLOOKUP, _xlfn._xlws.FILTER); the sheet names them plainly.
      let formula = fTag?.[2] ? unescape(fTag[2]).replace(/_xlfn\.ANCHORARRAY\(([^()]+)\)/gi, "$1#").replace(/_xlfn\.(?:_xlws\.)?/gi, "") : undefined;
      if (si !== undefined) {
        const first = sharedF.get(si);
        if (formula) sharedF.set(si, { text: formula, col, row });
        else if (first) formula = shiftFormula(`=${first.text}`, col - first.col, row - first.row).slice(1);
      }
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let input: string;
      if (formula) input = `=${formula}`;
      else if (type === "s") input = keepAsText(shared[Number(v)] ?? "");
      else if (type === "inlineStr") input = keepAsText(textOf(body));
      else if (type === "b") input = v === "1" ? "TRUE" : "FALSE";
      else if (type === "str" || type === "e") input = unescape(v ?? "");
      else if (v !== undefined && kinds.has(Number(attr(tag, "s") ?? -1))) {
        const n = Number(v);
        const kind = kinds.get(Number(attr(tag, "s")));
        const two = (x: number) => String(x).padStart(2, "0");
        if (kind === "date" || kind === "datetime") {
          const d = serialToDate(n);
          input = `${d.y}-${two(d.m)}-${two(d.d)}${kind === "datetime" ? ` ${two(d.h)}:${two(d.min)}:${two(d.s)}` : ""}`;
        } else if (kind === "time") {
          // Hours keep counting past a day, so a 29:45 total stays 29:45.
          const secs = Math.round(n * 86400);
          input = `${Math.floor(secs / 3600)}:${two(Math.floor(secs / 60) % 60)}:${two(secs % 60)}`;
        } else if (kind === "percent") input = `${Number((n * 100).toPrecision(12))}%`;
        else {
          const sym = kinds.symbols?.get(Number(attr(tag, "s"))) ?? "$";
          input = n < 0 ? `-${sym}${-n}` : `${sym}${n}`;
        }
      } else input = v ?? "";
      // Text that would read as a formula stays text.
      if (!formula && input.startsWith("=")) input = `'${input}`;
      if (input === "") continue;
      while (grid.length < row) grid.push([]);
      const line = grid[row - 1];
      while (line.length < col) line.push("");
      line[col - 1] = input;
    }
    const merges = [...xml.matchAll(/<mergeCell\s[^>]*>/g)].map((mc) => parseRectA1(attr(mc[0], "ref") ?? "")).filter((r): r is Rect => !!r);
    // Dropdowns with their choices written out ("a,b,c"); a list read from a range has nothing to carry over.
    const lists: NonNullable<ImportTable["lists"]> = [];
    for (const dv of xml.matchAll(/<dataValidation\s([^>]*)>([\s\S]*?)<\/dataValidation>/g)) {
      const head = ` ${dv[1]}`;
      const values = (unescape(dv[2].match(/<formula1>([\s\S]*?)<\/formula1>/)?.[1] ?? "").match(/^"([\s\S]*)"$/)?.[1] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      if (attr(head, "type") !== "list" || !values.length) continue;
      const strict = attr(head, "showErrorMessage") === "1" && (attr(head, "errorStyle") ?? "stop") === "stop";
      for (const part of (attr(head, "sqref") ?? "").split(/\s+/)) {
        const rect = parseRectA1(part);
        if (rect) lists.push({ rect, values, strict });
      }
    }
    const dates: NonNullable<ImportTable["dates"]> = [];
    for (const dv of xml.matchAll(/<dataValidation\s([^>]*)>/g)) {
      const head = ` ${dv[1]}`;
      if (attr(head, "type") !== "date") continue;
      const strict = attr(head, "showErrorMessage") === "1" && (attr(head, "errorStyle") ?? "stop") === "stop";
      for (const part of (attr(head, "sqref") ?? "").split(/\s+/)) {
        const rect = parseRectA1(part);
        if (rect) dates.push({ rect, strict });
      }
    }
    const conds = condsOf(xml, dxfs);
    tables.push({ name, grid, ...(styles.length ? { styles } : {}), ...(merges.length ? { merges } : {}), ...(lists.length ? { lists } : {}), ...(dates.length ? { dates } : {}), ...(conds.length ? { conds } : {}) });
  }
  if (!tables.length) throw new Error("This workbook has no sheets");
  return tables;
}
