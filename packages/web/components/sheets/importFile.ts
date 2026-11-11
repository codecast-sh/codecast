// Reading a dropped or picked file into tables of cell inputs: CSV / TSV
// text, or an Excel workbook (.xlsx, one table per worksheet, with formulas,
// shared strings and date formats). No dependency: an .xlsx is a zip of XML,
// read here with the browser's DecompressionStream.
import { parseTable, serialToDate, shiftFormula } from "@codecast/shared/artifacts/sheets";

export type ImportedTable = { name: string; grid: string[][] };

/** Files the importer reads, for an <input accept>. */
export const IMPORT_ACCEPT = ".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_ROWS = 50_000;

export async function readSheetFile(file: File): Promise<ImportedTable[]> {
  const base = file.name.replace(/\.[^.]+$/, "") || "Imported";
  if (/\.xlsx$/i.test(file.name) || file.type.includes("spreadsheetml")) return readXlsx(new Uint8Array(await file.arrayBuffer()));
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
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const PERCENT_FMT_IDS = new Set([9, 10]);
const CURRENCY_FMT_IDS = new Set([5, 6, 7, 8, 44]);

type CellKind = "date" | "percent" | "currency";

/** What each cell style shows a number as, so an import types it the same way ("12%", "$1,200", a date). */
function styleKinds(stylesXml: string | undefined): Map<number, CellKind> {
  const out = new Map<number, CellKind>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(m[0], "numFmtId")), unescape(attr(m[0], "formatCode") ?? ""));
  const xfs = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const code = custom.get(id);
    const bare = code?.replace(/"[^"]*"|\[[^\]]*\]/g, "") ?? "";
    // A custom code is a date when it names days, months or years outside quotes and brackets.
    if (DATE_FMT_IDS.has(id) || (code && /[dmy]/i.test(bare))) out.set(i, "date");
    else if (PERCENT_FMT_IDS.has(id) || bare.includes("%")) out.set(i, "percent");
    else if (CURRENCY_FMT_IDS.has(id) || code?.includes("$")) out.set(i, "currency");
  });
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
    /** Shared formulas: Excel writes the first of a run in full and the rest by its id; each copy shifts from the first. */
    const sharedF = new Map<string, { text: string; col: number; row: number }>();
    for (const c of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = ` ${c[1]}`;
      const ref = attr(tag, "r");
      if (!ref) continue;
      const row = Number(ref.match(/\d+$/)?.[0]);
      if (!row || row > MAX_ROWS) continue;
      const col = colIndexOf(ref);
      const body = c[2] ?? "";
      const type = attr(tag, "t");
      const fTag = body.match(/<f(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/f>)/);
      const si = fTag ? attr(` ${fTag[1] ?? ""}`, "si") : undefined;
      let formula = fTag?.[2] ? unescape(fTag[2]) : undefined;
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
        if (kind === "date") {
          const d = serialToDate(n);
          input = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
        } else if (kind === "percent") input = `${Number((n * 100).toPrecision(12))}%`;
        else input = n < 0 ? `-$${-n}` : `$${n}`;
      } else input = v ?? "";
      // Text that would read as a formula stays text.
      if (!formula && input.startsWith("=")) input = `'${input}`;
      if (input === "") continue;
      while (grid.length < row) grid.push([]);
      const line = grid[row - 1];
      while (line.length < col) line.push("");
      line[col - 1] = input;
    }
    tables.push({ name, grid });
  }
  if (!tables.length) throw new Error("This workbook has no sheets");
  return tables;
}
