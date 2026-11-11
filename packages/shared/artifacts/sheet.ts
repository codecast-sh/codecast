// Sheets (ct-91885). A sheet doc holds tabs of cells; every write is an
// element op (see sheets/model.ts for the element shapes). The engine,
// formats and op generators live in ./sheets; this file is the product spec:
// the compact A1 view an agent reads, the CLI verbs it writes with, and the
// range read API dashboards bind to.
import type { ArtifactElement, ArtifactOp, ArtifactPosition, Json } from "./core";
import { foldOps, fromElement, toElement } from "./core";
import type { ArtifactSpec, ArtifactView, VerbResult } from "./spec";
import { newElementKey } from "./spec";
import { isFormula } from "./sheets/formula";
import { formatValue } from "./sheets/format";
import { buildModel, inheritedFormat, PALETTE, readSheetRange, readSheetTab, resolveRange, styleOf, tabByName, workbookFor, type CellEl, type PaletteColor, type SheetModel, type TabMeta, type QuerySource } from "./sheets/model";
import {
  addTabOps,
  borderOps,
  clearOps,
  colWidthOps,
  deleteTabOps,
  fillOps,
  gridOps,
  parseTsv,
  renameTabOps,
  sortOps,
  structuralOps,
  styleOps,
  tabPatchOps,
  fitWidthOps,
  importTablesOps,
  parseTable,
  validationOps,
  type StylePatch,
} from "./sheets/ops";
import { DEFAULT_TAB, a1, colIndex as colIdx, colLetters as colLtrs, parseA1 as parseA1Ref, parseKey, parseQualifiedRange, quoteTabName, rectA1, tabKey, type Rect } from "./sheets/refs";

export { readSheetRange, readSheetTab, buildModel, workbookFor, DEFAULT_TAB };
export type { SheetModel, TabMeta, CellEl };

export type SheetCell = { input?: string };

/** `c:<tab>!<A1>`: the key a cell is stored under (tab by id). */
export function cellKey(tab: string, ref: string): string {
  return `c:${tab}!${ref.toUpperCase().replace(/\$/g, "")}`;
}

export function parseCellKey(key: string): { tab: string; col: number; row: number; a1: string } | null {
  const k = parseKey(key);
  return k?.type === "cell" ? { tab: k.tab, col: k.col, row: k.row, a1: a1(k.col, k.row) } : null;
}

export const colIndex = colIdx;
export const colLetters = colLtrs;
export const parseA1 = parseA1Ref;

/** The range a set of written keys covers, as a presence position ("Tab!A1:C4", tab by id). */
export function rangeOf(keys: string[]): ArtifactPosition | undefined {
  const cells = keys.map(parseCellKey).filter((c): c is NonNullable<typeof c> => !!c);
  if (cells.length === 0) return undefined;
  const tab = cells[0].tab;
  const same = cells.filter((c) => c.tab === tab);
  const r: Rect = {
    c0: Math.min(...same.map((c) => c.col)),
    c1: Math.max(...same.map((c) => c.col)),
    r0: Math.min(...same.map((c) => c.row)),
    r1: Math.max(...same.map((c) => c.row)),
  };
  const text = rectA1(r);
  return text.includes(":") ? { range: `${tab}!${text}` } : { cell: `${tab}!${text}` };
}

// ── The agent's view ────────────────────────────────────────────────────────

const DESCRIBE_ROW_CAP = 250;

function cellText(el: CellEl, value: ReturnType<ReturnType<typeof workbookFor>["value"]>, implied: Parameters<typeof formatValue>[2], inherit?: () => Parameters<typeof formatValue>[2], header = false): string {
  const input = typeof el.input === "string" ? el.input : "";
  if (isFormula(input) && !el.nf && typeof value === "number") implied = inherit?.() ?? implied;
  // A table header is labels: numbers there read as typed.
  const shown = header && typeof value === "number" ? formatValue(value, undefined, implied?.nf === "date" ? implied : undefined) : formatValue(value, styleOf(el), implied);
  if (isFormula(input)) return `${input} → ${shown === "" ? "(blank)" : shown}`;
  if (typeof value === "string") return JSON.stringify(input);
  return input;
}

function styleTokens(el: CellEl): string[] {
  const s = styleOf(el);
  const out: string[] = [];
  if (s.b) out.push("b");
  if (s.i) out.push("i");
  if (s.u) out.push("u");
  if (s.fs) out.push(`size=${s.fs}`);
  if (s.al) out.push(`align=${s.al}`);
  if (s.color) out.push(`color=${s.color}`);
  if (s.fill) out.push(`fill=${s.fill}`);
  if (s.nf) out.push(`nf=${s.nf}`);
  if (s.dp !== undefined) out.push(`dp=${s.dp}`);
  if (s.sign) out.push("sign");
  if (s.bd) out.push(`border=${s.bd}`);
  if (s.wrap) out.push("wrap");
  return out;
}

/** Group cells with the same style into rectangles: "A1:G1 b fill=red". */
function styleRanges(cells: Array<{ col: number; row: number; sig: string }>): Array<{ sig: string; rects: Rect[] }> {
  const bySig = new Map<string, Array<{ col: number; row: number }>>();
  for (const c of cells) {
    if (!c.sig) continue;
    const list = bySig.get(c.sig) ?? [];
    list.push(c);
    bySig.set(c.sig, list);
  }
  const out: Array<{ sig: string; rects: Rect[] }> = [];
  for (const [sig, list] of bySig) {
    list.sort((a, b) => a.row - b.row || a.col - b.col);
    // Horizontal runs, then stack identical runs on consecutive rows.
    const runs: Rect[] = [];
    for (const c of list) {
      const last = runs[runs.length - 1];
      if (last && last.r0 === c.row && last.c1 === c.col - 1) last.c1 = c.col;
      else runs.push({ c0: c.col, c1: c.col, r0: c.row, r1: c.row });
    }
    const rects: Rect[] = [];
    for (const run of runs) {
      const above = rects.find((r) => r.c0 === run.c0 && r.c1 === run.c1 && r.r1 === run.r0 - 1);
      if (above) above.r1 = run.r1;
      else rects.push({ ...run });
    }
    out.push({ sig, rects });
  }
  return out;
}

export function describeSheet(view: ArtifactView): string {
  const model = buildModel(view.elements);
  const wb = workbookFor(model);
  const out: string[] = [];
  out.push(`sheet "${view.title}" · ${model.tabs.length} tab${model.tabs.length === 1 ? "" : "s"}: ${model.tabs.map((t) => t.name).join(", ")}`);
  out.push(`cells read as A1 input; formulas as =formula → shown value. Tab refs in formulas: ${quoteTabName("Tab name")}!A1.`);
  for (const meta of model.tabs) {
    const t = model.byId.get(meta.id)!;
    const notes: string[] = [];
    notes.push(t.rows ? `used A1:${a1(t.cols, t.rows)}` : "empty");
    if (meta.frozenRows) notes.push(`frozen ${meta.frozenRows} row${meta.frozenRows > 1 ? "s" : ""}`);
    if (meta.frozenCols) notes.push(`frozen ${meta.frozenCols} col${meta.frozenCols > 1 ? "s" : ""}`);
    if (meta.query) notes.push(`live query: ${meta.query.source}${meta.query.project ? ` project=${meta.query.project}` : ""} (read only, refreshes itself)`);
    if (meta.filter) notes.push(`filter on row ${meta.filter.row}`);
    out.push("");
    out.push(`[${meta.name}] ${notes.join(" · ")}`);
    const byRow = new Map<number, Array<[number, CellEl]>>();
    const styled: Array<{ col: number; row: number; sig: string }> = [];
    for (const [n, el] of t.cells) {
      const row = Math.floor(n / 32768), col = n % 32768;
      styled.push({ col, row, sig: styleTokens(el).join(" ") });
      if (typeof el.input !== "string" || el.input === "") continue;
      const line = byRow.get(row) ?? [];
      line.push([col, el]);
      byRow.set(row, line);
    }
    const rows = [...byRow.keys()].sort((a, b) => a - b);
    for (const r of rows.slice(0, DESCRIBE_ROW_CAP)) {
      const parts = byRow
        .get(r)!
        .sort((a, b) => a[0] - b[0])
        .map(([c, el]) => {
          const info = wb.cell(meta.id, c, r);
          const header = model.tables.some((tb) => tb.tab === meta.id && tb.rect.r0 === r && c >= tb.rect.c0 && c <= tb.rect.c1);
          return `${a1(c, r)} ${cellText(el, info?.value ?? null, info?.implied, () => inheritedFormat(model, meta.id, String(el.input)), header)}`;
        });
      out.push(parts.join(" | "));
    }
    if (rows.length > DESCRIBE_ROW_CAP) {
      const from = rows[DESCRIBE_ROW_CAP];
      out.push(`… ${rows.length - DESCRIBE_ROW_CAP} more rows from row ${from}; read them with: range <doc> ${quoteTabName(meta.name)}!A${from}:${colLtrs(Math.max(t.cols, 1))}${from + 199}`);
    }
    const groups = styleRanges(styled);
    if (groups.length) {
      out.push("formats:");
      for (const g of groups) out.push(`  ${g.rects.map(rectA1).join(",")} ${g.sig}`);
    }
    const conds = model.conds.filter((c) => c.tab === meta.id);
    const tables = model.tables.filter((c) => c.tab === meta.id);
    for (const c of conds) out.push(`  cond ${rectA1(c.rect)} ${c.rule}${c.value !== undefined ? ` ${c.value}` : ""}${c.color ? ` ${c.color}` : ""}`);
    for (const tb of tables) out.push(`  table ${rectA1(tb.rect)} ${tb.color}${tb.banded ? " banded" : ""}`);
    for (const v of model.validations.filter((x) => x.tab === meta.id))
      out.push(`  validate ${rectA1(v.rect)} ${v.rule}${v.options.length ? ` ${v.options.map((o) => (o.color ? `${o.v}:${o.color}` : o.v)).join(",")}` : ""}${v.strict ? " --strict" : ""}`);
  }
  return out.join("\n");
}

// ── Verbs ───────────────────────────────────────────────────────────────────

type Target = { model: SheetModel; tab: TabMeta; rect: Rect; created: ArtifactOp[] };

/** Resolve "Tab!A1:C4" for a write: an unknown tab name creates the tab. */
function target(view: ArtifactView, ref: string | undefined, usage: string, create = true): Target {
  if (!ref) throw new Error(`usage: ${usage}`);
  const model = buildModel(view.elements);
  const q = parseQualifiedRange(ref);
  if (!q) throw new Error(`bad range ${ref} (use A1, B2:D9 or Tab!A1)`);
  let tab = q.tab !== undefined ? tabByName(model, q.tab) : model.tabs[0];
  const created: ArtifactOp[] = [];
  if (!tab) {
    if (!create) throw new Error(`no tab named ${q.tab}`);
    const add = addTabOps(model, q.tab!);
    created.push(...add.ops);
    tab = { id: add.id, name: q.tab!, order: 0, frozenRows: 0, frozenCols: 0 };
  } else if (!view.get(tabKey(tab.id))) {
    // The implicit first tab gets its element on first write, so renames and freezes have something to set.
    created.push(...tabPatchOps(model, tab.id, {}));
  }
  return { model, tab, rect: q.rect, created };
}

function pos(tab: TabMeta, rect: Rect): ArtifactPosition {
  const text = rectA1(rect);
  return text.includes(":") ? { range: `${tab.id}!${text}` } : { cell: `${tab.id}!${text}` };
}

function done(t: Target, ops: ArtifactOp[], status: string): VerbResult {
  return { ops: [...t.created, ...ops], position: pos(t.tab, t.rect), status };
}

/** After a write, widen the touched columns nobody sized so headers and numbers are not clipped. */
function withFit(view: ArtifactView, t: Target, ops: ArtifactOp[]): ArtifactOp[] {
  const state = new Map(view.elements.map((e) => [e.key, fromElement(e)]));
  foldOps(state, [...t.created, ...ops]);
  const after = buildModel([...state].filter(([, s]) => !s.deleted).map(([k, s]) => toElement(k, s)));
  const cols: number[] = [];
  for (let c = t.rect.c0; c <= t.rect.c1; c++) cols.push(c);
  return [...ops, ...fitWidthOps(after, workbookFor(after), t.tab.id, cols, { onlyUnset: true })];
}

function parseStyleArgs(args: string[]): { patch: StylePatch; border?: "all" | "outer" | "bottom" | "none" } {
  const patch: StylePatch = {};
  let border: "all" | "outer" | "bottom" | "none" | undefined;
  const color = (v: string): PaletteColor | null => {
    if (v === "none") return null;
    if (!(PALETTE as readonly string[]).includes(v)) throw new Error(`color must be one of ${PALETTE.join(", ")} or none`);
    return v as PaletteColor;
  };
  for (const raw of args) {
    const [k, v] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, ""];
    const off = k.startsWith("-");
    const key = off ? k.slice(1) : k;
    switch (key) {
      case "b":
      case "bold":
        patch.b = off ? null : true;
        break;
      case "i":
      case "italic":
        patch.i = off ? null : true;
        break;
      case "u":
      case "underline":
        patch.u = off ? null : true;
        break;
      case "sign":
        patch.sign = off ? null : true;
        break;
      case "wrap":
        patch.wrap = off ? null : true;
        break;
      case "size":
        patch.fs = off ? null : Number(v) || null;
        break;
      case "align":
        if (!["left", "center", "right", ""].includes(v)) throw new Error("align must be left, center or right");
        patch.al = off || !v ? null : (v as "left");
        break;
      case "color":
        patch.color = off ? null : color(v);
        break;
      case "fill":
        patch.fill = off ? null : color(v);
        break;
      case "dp":
        patch.dp = off ? null : Math.max(0, Math.min(10, Number(v)));
        break;
      case "nf":
        if (!["number", "percent", "currency", "date", "datetime", "text", "plain", "check"].includes(v)) throw new Error("nf must be number, percent, currency, date, datetime, text, check or plain");
        patch.nf = v === "plain" ? null : (v as "number");
        break;
      case "num":
      case "number":
        patch.nf = "number";
        break;
      case "pct":
      case "percent":
        patch.nf = "percent";
        break;
      case "cur":
      case "currency":
        patch.nf = "currency";
        break;
      case "date":
        patch.nf = "date";
        break;
      case "check":
        patch.nf = "check";
        break;
      case "border":
        if (!["all", "outer", "bottom", "none"].includes(v)) throw new Error("border must be all, outer, bottom or none");
        border = v as "all";
        break;
      case "clear":
        for (const f of ["b", "i", "u", "fs", "al", "color", "fill", "nf", "dp", "sign", "cur", "bd", "wrap"] as const) (patch as Record<string, null>)[f] = null;
        break;
      default:
        throw new Error(`unknown format ${raw}`);
    }
  }
  return { patch, border };
}

const COND_RULES = ["sign", "scale", "gt", "lt", "eq", "contains"] as const;

const verbs: ArtifactSpec["verbs"] = {
  set: {
    summary: "Set one cell's input (a number, text, or =formula)",
    usage: "set <doc> <Tab!A1> <value...>",
    run(view, args) {
      const [ref, ...rest] = args;
      if (rest.length === 0) throw new Error("usage: set <doc> <Tab!A1> <value...>");
      const t = target(view, ref, "set <doc> <Tab!A1> <value...>");
      return done(t, withFit(view, t, gridOps(t.model, t.tab.id, t.rect.c0, t.rect.r0, [[rest.join(" ")]])), `set ${rectA1(t.rect)}`);
    },
  },
  write: {
    summary: "Write a block of inputs from stdin (TSV: one line per row, tabs between cells; formulas allowed). An unknown tab is created.",
    usage: "write <doc> <Tab!A1> < block.tsv",
    stdin: true,
    run(view, args, stdin) {
      const t = target(view, args[0], "write <doc> <Tab!A1> < block.tsv");
      const grid = parseTsv(stdin ?? "");
      const width = Math.max(...grid.map((r) => r.length));
      const rect = { c0: t.rect.c0, r0: t.rect.r0, c1: t.rect.c0 + width - 1, r1: t.rect.r0 + grid.length - 1 };
      const tt = { ...t, rect };
      return done(tt, withFit(view, tt, gridOps(t.model, t.tab.id, t.rect.c0, t.rect.r0, grid)), `wrote ${rectA1(rect)}`);
    },
  },
  fmt: {
    summary: "Format a range: b i u size=N align=left|center|right color=C fill=C num|pct|cur|date dp=N sign border=all|outer|bottom|none wrap clear (-b etc. removes)",
    usage: "fmt <doc> <Tab!A1:C4> <format...>",
    run(view, args) {
      const [ref, ...rest] = args;
      if (rest.length === 0) throw new Error("usage: fmt <doc> <Tab!A1:C4> <format...>");
      const t = target(view, ref, "fmt <doc> <range> <format...>");
      const { patch, border } = parseStyleArgs(rest);
      const ops = Object.keys(patch).length ? styleOps(t.model, t.tab.id, t.rect, patch) : [];
      if (border) ops.push(...borderOps(t.model, t.tab.id, t.rect, border));
      // A format changes shown widths (21000 -> $21,000.00): refit what nobody sized.
      return done(t, withFit(view, t, ops), `formatting ${rectA1(t.rect)}`);
    },
  },
  fill: {
    summary: "Fill from a source range across a larger range, like dragging the fill handle (formulas shift, number series continue)",
    usage: "fill <doc> <Tab!D2> <Tab!D2:D20>",
    run(view, args) {
      const t = target(view, args[0], "fill <doc> <source> <destination>", false);
      const dest = parseQualifiedRange(args[1] ?? "");
      if (!dest) throw new Error("usage: fill <doc> <source> <destination>");
      return done({ ...t, rect: dest.rect }, fillOps(t.model, t.tab.id, t.rect, dest.rect), `filling ${rectA1(dest.rect)}`);
    },
  },
  clear: {
    summary: "Clear a range's contents (--all also clears formats)",
    usage: "clear <doc> <Tab!A1:C4> [--all]",
    run(view, args) {
      const t = target(view, args[0], "clear <doc> <range> [--all]", false);
      return done(t, clearOps(t.model, t.tab.id, t.rect, args.includes("--all") ? "all" : "contents"), `clearing ${rectA1(t.rect)}`);
    },
  },
  cond: {
    summary: `Conditional color on a range: sign (green positive, red negative) | scale [color] | gt|lt|eq <n> <color> | contains <text> <color> | clear (all rules on the range). Rules stack: run it once per rule`,
    usage: "cond <doc> <Tab!B2:G6> <rule> [value] [color]",
    run(view, args) {
      const [ref, rule, ...rest] = args;
      const t = target(view, ref, "cond <doc> <range> <rule> [value] [color]", false);
      const range = rectA1(t.rect);
      const existing = t.model.conds.filter((c) => c.tab === t.tab.id && rectA1(c.rect) === range);
      if (rule === "clear") return done(t, existing.map((c) => ({ k: c.key, del: true as const })), `clearing colors on ${range}`);
      if (!(COND_RULES as readonly string[]).includes(rule ?? "")) throw new Error(`rule must be one of ${COND_RULES.join(", ")}, or clear`);
      const fields: Record<string, Json> = { tab: t.tab.id, range, rule: rule! };
      const needsValue = rule === "gt" || rule === "lt" || rule === "eq" || rule === "contains";
      if (needsValue) {
        if (rest[0] === undefined) throw new Error(`${rule} needs a value`);
        fields.value = rule === "contains" || Number.isNaN(Number(rest[0])) ? rest[0] : Number(rest[0]);
      }
      const color = needsValue ? rest[1] : rest[0];
      if (color) {
        if (!(PALETTE as readonly string[]).includes(color)) throw new Error(`color must be one of ${PALETTE.join(", ")}`);
        fields.color = color;
      }
      // Rules stack on a range (Offer green and Rejected gray on one Stage column); the same rule and value restyles in place.
      const same = existing.find((c) => c.rule === rule && String(c.value ?? "") === String(fields.value ?? ""));
      const key = same?.key ?? newElementKey("cf");
      return done(t, [{ k: key, put: { kind: "cf", ...fields } }], `coloring ${range}`);
    },
  },
  table: {
    summary: "Style a range as a table: tinted bold header row and banded rows (--plain drops the bands; none removes)",
    usage: "table <doc> <Tab!A1:G6> [color|none] [--plain]",
    run(view, args) {
      const [ref, color = "blue"] = args;
      const t = target(view, ref, "table <doc> <range> [color]", false);
      const range = rectA1(t.rect);
      const existing = t.model.tables.filter((x) => x.tab === t.tab.id && rectA1(x.rect) === range);
      if (color === "none") return done(t, existing.map((x) => ({ k: x.key, del: true as const })), `unstyling ${range}`);
      if (!(PALETTE as readonly string[]).includes(color)) throw new Error(`color must be one of ${PALETTE.join(", ")}`);
      const key = existing[0]?.key ?? newElementKey("tbl");
      return done(t, [{ k: key, put: { kind: "table", tab: t.tab.id, range, color, banded: !args.includes("--plain") } }], `styling ${range}`);
    },
  },
  import: {
    summary: "Import CSV or TSV from stdin as a new tab (named, or Imported), columns fitted",
    usage: "import <doc> [tab name] < data.csv",
    stdin: true,
    run(view, args, stdin) {
      const grid = parseTable(stdin ?? "");
      if (!grid.length || (grid.length === 1 && grid[0].every((v) => v === ""))) throw new Error("nothing to import on stdin");
      const name = args.join(" ").trim() || "Imported";
      const r = importTablesOps(buildModel(view.elements), [{ name, grid }]);
      const width = Math.max(...grid.map((row) => row.length));
      return { ops: r.ops, position: { range: `${r.tabIds[0]}!A1:${colLtrs(width)}${grid.length}` }, status: `imported ${grid.length} rows` };
    },
  },
  validate: {
    summary: "What a range accepts. list: a dropdown whose values paint as colored chips (Value:color, comma separated; --strict refuses anything else). date: a date picker. clear removes it",
    usage: "validate <doc> <Tab!C2:C200> list \"Applied:gray,Screen:blue,Offer:green\" [--strict] | date | clear",
    run(view, args) {
      const [ref, rule, spec] = args;
      const t = target(view, ref, "validate <doc> <range> list|date|clear ...", false);
      const range = rectA1(t.rect);
      if (rule === "clear") return done(t, validationOps(t.model, t.tab.id, t.rect, null), `clearing validation on ${range}`);
      if (rule !== "list" && rule !== "date") throw new Error("rule must be list, date or clear");
      const options: Array<{ v: string; color?: string }> = [];
      if (rule === "list") {
        if (!spec || spec.startsWith("--")) throw new Error('list needs its values: list "Open:blue,Done:green"');
        for (const part of spec.split(",")) {
          const raw = part.trim();
          const at = raw.lastIndexOf(":");
          const color = at > 0 ? raw.slice(at + 1).trim() : "";
          const known = (PALETTE as readonly string[]).includes(color);
          if (at > 0 && color && !known && /^[a-z]+$/.test(color)) throw new Error(`color must be one of ${PALETTE.join(", ")}`);
          options.push(known ? { v: raw.slice(0, at).trim(), color } : { v: raw });
        }
      }
      return done(t, validationOps(t.model, t.tab.id, t.rect, rule, options, args.includes("--strict")), `validating ${range}`);
    },
  },
  insert: {
    summary: "Insert rows before a row, or columns before a column; formulas everywhere adjust",
    usage: "insert <doc> rows <Tab!5> [count] | insert <doc> cols <Tab!C> [count]",
    run(view, args) {
      return structuralVerb(view, args, 1);
    },
  },
  delete: {
    summary: "Delete rows or columns; formulas that pointed into them become #REF!",
    usage: "delete <doc> rows <Tab!5:7> | delete <doc> cols <Tab!C:D>",
    run(view, args) {
      return structuralVerb(view, args, -1);
    },
  },
  sort: {
    summary: "Sort a range's rows by one column (exclude the header row from the range)",
    usage: "sort <doc> <Tab!A2:G20> by <C> [desc]",
    run(view, args) {
      const [ref, by, colArg, dir] = args;
      if (by !== "by" || !colArg) throw new Error("usage: sort <doc> <range> by <C> [desc]");
      const t = target(view, ref, "sort <doc> <range> by <C> [desc]", false);
      const col = colIdx(colArg.replace(/[^A-Za-z]/g, ""));
      const wb = workbookFor(t.model);
      return done(t, sortOps(t.model, wb, t.tab.id, t.rect, col, dir === "desc"), `sorting ${rectA1(t.rect)}`);
    },
  },
  width: {
    summary: "Set column widths in px",
    usage: "width <doc> <Tab!A:C> <px>",
    run(view, args) {
      const [ref, px] = args;
      const m = (ref ?? "").match(/^(?:(.+)!)?([A-Za-z]+)(?::([A-Za-z]+))?$/);
      if (!m || !Number(px)) throw new Error("usage: width <doc> <Tab!A:C> <px>");
      const t = target(view, `${m[1] ? `${m[1]}!` : ""}A1`, "width", false);
      const c0 = colIdx(m[2]), c1 = colIdx(m[3] ?? m[2]);
      const cols = Array.from({ length: Math.abs(c1 - c0) + 1 }, (_, i) => Math.min(c0, c1) + i);
      return { ops: colWidthOps(t.tab.id, cols, Math.max(24, Math.min(800, Number(px)))), status: "resizing" };
    },
  },
  fit: {
    summary: "Fit column widths to their contents (headers and formatted values)",
    usage: "fit <doc> <Tab!A:G>",
    run(view, args) {
      const m = (args[0] ?? "").match(/^(?:(.+)!)?([A-Za-z]+)(?::([A-Za-z]+))?$/);
      if (!m) throw new Error("usage: fit <doc> <Tab!A:G>");
      const t = target(view, `${m[1] ? `${m[1]}!` : ""}A1`, "fit", false);
      const c0 = colIdx(m[2]), c1 = colIdx(m[3] ?? m[2]);
      const cols = Array.from({ length: Math.abs(c1 - c0) + 1 }, (_, i) => Math.min(c0, c1) + i);
      return { ops: fitWidthOps(t.model, workbookFor(t.model), t.tab.id, cols), status: "fitting widths" };
    },
  },
  tab: {
    summary: "Tabs: add <name> | rename <name> <new> | rm <name> | freeze <name> <rows> [cols]",
    usage: "tab <doc> add|rename|rm|freeze ...",
    run(view, args) {
      const [action, name, ...rest] = args;
      const model = buildModel(view.elements);
      if (!name) throw new Error("usage: tab <doc> add|rename|rm|freeze <name> ...");
      if (action === "add") {
        const add = addTabOps(model, name);
        return { ops: add.ops, status: `added tab ${name}` };
      }
      const tab = tabByName(model, name);
      if (!tab) throw new Error(`no tab named ${name}`);
      if (action === "rename") {
        if (!rest[0]) throw new Error("usage: tab <doc> rename <name> <new name>");
        return { ops: renameTabOps(model, tab.id, rest.join(" ")), status: `renamed ${name}` };
      }
      if (action === "rm") {
        if (model.tabs.length === 1) throw new Error("a sheet keeps at least one tab");
        return { ops: deleteTabOps(model, tab.id), status: `removed ${name}` };
      }
      if (action === "freeze") {
        const rows = Number(rest[0] ?? 0), cols = Number(rest[1] ?? 0);
        return { ops: tabPatchOps(model, tab.id, { frozen_rows: rows || null, frozen_cols: cols || null }), status: `froze ${name}` };
      }
      throw new Error("usage: tab <doc> add|rename|rm|freeze <name> ...");
    },
  },
  query: {
    summary: "Make a tab a live query over codecast data that refreshes itself: tasks | sessions | prs | metrics [project=<name>] [status=<s>] [limit=N]",
    usage: "query <doc> <tab name> <tasks|sessions|prs|metrics> [project=..] [status=..] [limit=..]",
    run(view, args) {
      const [name, source, ...rest] = args;
      if (!name || !["tasks", "sessions", "prs", "metrics"].includes(source ?? "")) throw new Error("usage: query <doc> <tab name> <tasks|sessions|prs|metrics> [project=..]");
      const model = buildModel(view.elements);
      const query: Record<string, Json> = { source: source as QuerySource };
      for (const kv of rest) {
        const [k, v] = kv.split("=");
        if (k === "project" || k === "status") query[k] = v;
        else if (k === "limit") query.limit = Number(v);
        else throw new Error(`unknown query option ${kv}`);
      }
      const tab = tabByName(model, name);
      if (tab) return { ops: tabPatchOps(model, tab.id, { query, refreshed_at: null }), status: `query tab ${name}` };
      const add = addTabOps(model, name, { query, frozen_rows: 1 });
      return { ops: add.ops, status: `query tab ${name}` };
    },
  },
  range: {
    summary: "Read evaluated values of a range as TSV (--json for {tab, rect, values}); writes nothing",
    usage: "range <doc> <Tab!A1:D20> [--json]",
    run(view, args) {
      const ref = args.find((a) => !a.startsWith("--"));
      if (!ref) throw new Error("usage: range <doc> <Tab!A1:D20> [--json]");
      const r = readSheetRange(view.elements, ref);
      if ("error" in r) throw new Error(r.error);
      const text = args.includes("--json") ? JSON.stringify(r) : r.values.map((row) => row.map((v) => (v === null ? "" : String(v))).join("\t")).join("\n");
      return { ops: [], status: text };
    },
  },
};

function structuralVerb(view: ArtifactView, args: string[], sign: 1 | -1): VerbResult {
  const [what, ref, countArg] = args;
  const usage = sign > 0 ? "insert <doc> rows <Tab!5> [count] | cols <Tab!C> [count]" : "delete <doc> rows <Tab!5:7> | cols <Tab!C:D>";
  if ((what !== "rows" && what !== "cols") || !ref) throw new Error(`usage: ${usage}`);
  const bang = ref.lastIndexOf("!");
  const tabPart = bang > 0 ? ref.slice(0, bang) : undefined;
  const spec = bang > 0 ? ref.slice(bang + 1) : ref;
  const model = buildModel(view.elements);
  const tab = tabPart !== undefined ? tabByName(model, tabPart.replace(/^'|'$/g, "")) : model.tabs[0];
  if (!tab) throw new Error(`no tab named ${tabPart}`);
  const [a, b = a] = spec.split(":");
  const toIdx = (s: string) => (what === "rows" ? Number(s) : colIdx(s.replace(/[^A-Za-z]/g, "")));
  const lo = Math.min(toIdx(a), toIdx(b)), hi = Math.max(toIdx(a), toIdx(b));
  if (!lo || lo < 1) throw new Error(`usage: ${usage}`);
  const count = sign > 0 ? Math.max(1, Number(countArg ?? 1)) : hi - lo + 1;
  const axis = what === "rows" ? "row" : "col";
  return { ops: structuralOps(model, tab.id, axis, lo, sign * count), status: `${sign > 0 ? "inserted" : "deleted"} ${count} ${what}` };
}

export const sheetSpec: ArtifactSpec = {
  type: "sheet",
  label: "Sheet",
  cli: "sheet",
  kinds: ["cell", "tab", "col", "row", "cf", "table", "dv"],
  describe: describeSheet,
  presenceFor: (_view, keys) => rangeOf(keys),
  seed: () => [{ k: tabKey(DEFAULT_TAB), put: { kind: "tab", name: DEFAULT_TAB, order: 0 } }],
  verbs,
  agentGuide: [
    "A sheet has tabs of cells. Read it with `read` (inputs, formulas → values, and formats per range). Address cells as Tab!A1; with no tab prefix you write the first tab. Quote tab names with spaces: 'Q4 plan'!A1.",
    "Write blocks with `write <doc> Tab!A1 < block.tsv` (one line per row, tabs between cells). Write formulas, not computed numbers, whenever a value derives from other cells, so people can change an input and watch it flow: =B2*(1+C2), =SUM(B2:B5), =Historical!B2, =XLOOKUP(A2,Historical!A:A,Historical!B:B).",
    "Functions: SUM AVERAGE MIN MAX COUNT COUNTA ROUND IF IFS IFERROR XLOOKUP VLOOKUP INDEX MATCH SUMIF(S) COUNTIF(S) AVERAGEIF TEXT DATE TODAY EDATE EOMONTH YEAR MONTH LEFT RIGHT MID CONCAT TEXTJOIN and more. Typed 10% is a percent, $1,200 currency, 2026-11-10 a date.",
    "Then format: `fmt <doc> A1:G1 b fill=blue`, `fmt <doc> C2:C6 pct sign`, `fmt <doc> B2:B6 num`, `fmt <doc> A6:G6 b border=outer`. Colors: red orange yellow green cyan blue violet magenta gray. A done/status column of TRUE/FALSE reads as checkboxes with `fmt <doc> Tab!E2:E40 check`. `table <doc> A1:G6 blue` gives a header and bands; `cond <doc> G2:G6 sign` colors gains green and losses red.",
    "Columns you write widen to fit on their own; `fit <doc> Tab!A:G` refits after you change content, `width <doc> Tab!A 220` sets one exactly.",
    "A column with a fixed set of values (status, stage, owner, priority) gets a dropdown: `validate <doc> Tab!C2:C200 list \"Todo:gray,Doing:blue,Done:green\"`; its values paint as colored chips and people pick from the list. A date column gets `validate <doc> Tab!F2:F200 date` and a date picker. Cover the rows people will add, not only the rows you wrote.",
    "A tracker: header row, one row per item, `tab <doc> freeze <tab> 1`. `query <doc> \"Open tasks\" tasks project=<name>` makes a tab that reads codecast tasks live. `range <doc> Tab!A1:D20` reads computed values back.",
  ].join("\n"),
};

/** The sheet ops for formatting a range from the web toolbar (re-exported for the view). */
export { styleOps, borderOps };
