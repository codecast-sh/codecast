// Edits as ops: every sheet gesture (typing, paste, fill, format, insert,
// delete, sort, tab changes) becomes a list of element ops here, so the web
// grid, the CLI verbs and tests all produce the same writes.
import { foldOps, toElement, type ArtifactOp } from "../core";
import type { Json } from "../core";
import { isFormula } from "./formula";
import { Workbook } from "./engine";
import { adjustFormula, adjustRangeText, mapFormulaRefs, refText, renameTabInFormula, shiftFormula, type Structural } from "./rewrite";
import { cellKey, colKey, colLetters, newTabId, normRect, parseKey, rectA1, rowKey, tabKey, type Rect } from "./refs";
import { buildModel, cellNum, inheritedFormat, STYLE_FIELDS, styleOf, workbookFor, type CellEl, type CellStyle, type CondRule, type SheetModel, type TabData, type TabMeta } from "./model";
import { formatValue } from "./format";
import { condOps, validationOps } from "./ruleOps";
import { newElementKey } from "../spec";
import { compareScalars, parseLiteral, type Scalar } from "./values";

type CellFields = Record<string, Json>;

function fieldsOf(el: CellEl): CellFields {
  const out: CellFields = {};
  for (const [k, v] of Object.entries(el)) {
    if (k === "key" || k === "kind" || k === "rev" || k === "by" || k === "at" || v === undefined) continue;
    out[k] = v as Json;
  }
  return out;
}

/** A copy (paste, fill) doesn't copy the comment thread; a move carries it. */
function withoutComment(f: CellFields): CellFields {
  const { cm: _cm, ...rest } = f;
  return rest;
}

function hasStyle(el: CellEl | undefined): boolean {
  return !!el && STYLE_FIELDS.some((f) => el[f] !== undefined);
}

function tabData(model: SheetModel, tabId: string): TabData | undefined {
  return model.byId.get(tabId);
}

/** Write raw inputs into cells, keeping each cell's style. "" clears the input. */
export function inputOps(model: SheetModel, tabId: string, cells: Array<{ col: number; row: number; input: string }>): ArtifactOp[] {
  const t = tabData(model, tabId);
  const ops: ArtifactOp[] = [];
  for (const c of cells) {
    const k = cellKey(tabId, c.col, c.row);
    const el = t?.cells.get(cellNum(c.col, c.row));
    if (c.input === "") {
      if (!el) continue;
      ops.push(hasStyle(el) ? { k, set: { input: null } } : { k, del: true });
    } else if (el) {
      if (el.input !== c.input) ops.push({ k, set: { input: c.input } });
    } else {
      ops.push({ k, put: { kind: "cell", input: c.input } });
    }
  }
  return ops;
}

/** A block of text values (a TSV paste, an agent's write) at an origin. */
export function gridOps(model: SheetModel, tabId: string, col: number, row: number, grid: string[][]): ArtifactOp[] {
  const cells: Array<{ col: number; row: number; input: string }> = [];
  grid.forEach((line, r) => line.forEach((input, c) => cells.push({ col: col + c, row: row + r, input })));
  return inputOps(model, tabId, cells);
}

/** Parse TSV the way Sheets and Excel put it on the clipboard: quoted fields may hold tabs, newlines and "". */
export function parseTsv(text: string): string[][] {
  return parseDelimited(text, "\t");
}

/** CSV or TSV by what the first line holds: a tab means TSV, else commas (or semicolons, Excel's European export). */
export function parseTable(text: string): string[][] {
  const first = text.slice(0, text.search(/\r?\n|$/));
  if (first.includes("\t")) return parseDelimited(text, "\t");
  const commas = (first.match(/,/g) ?? []).length, semis = (first.match(/;/g) ?? []).length;
  return parseDelimited(text, semis > commas ? ";" : ",");
}

/** Rows of fields split on a delimiter; a field may be quoted ("a, b", "say ""hi""", line breaks inside). */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  let atFieldStart = true;
  while (i < src.length) {
    const ch = src[i];
    if (atFieldStart && ch === '"') {
      // Quoted field: runs to the closing quote not followed by another.
      let j = i + 1;
      let val = "";
      let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            val += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        val += src[j++];
      }
      if (closed && (j >= src.length || src[j] === sep || src[j] === "\n")) {
        field = val;
        i = j;
        atFieldStart = false;
        continue;
      }
      // Not a well-formed quoted field: read it literally.
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      atFieldStart = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Values as TSV for the clipboard; fields with tabs, newlines or quotes are quoted. */
export function toTsv(grid: string[][]): string {
  return grid.map((r) => r.map((v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t")).join("\n");
}

/** What an internal copy carries: each cell's fields, and where it came from (so formulas shift). */
export type SheetClip = { col: number; row: number; cells: Array<Array<CellFields | null>>; /** Source row of each clip row (a filtered copy skips rows). */ rows?: number[] };

/** `rows` limits the clip to those rows (a filtered range copies what is visible). */
export function clipOf(model: SheetModel, tabId: string, rect: Rect, rows?: number[]): SheetClip {
  const t = tabData(model, tabId);
  const cells: Array<Array<CellFields | null>> = [];
  for (const r of rows ?? Array.from({ length: rect.r1 - rect.r0 + 1 }, (_, i) => rect.r0 + i)) {
    const line: Array<CellFields | null> = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      const el = t?.cells.get(cellNum(c, r));
      line.push(el ? withoutComment(fieldsOf(el)) : null);
    }
    cells.push(line);
  }
  return { col: rect.c0, row: rect.r0, cells, ...(rows ? { rows } : {}) };
}

/** Paste an internal clip at an origin: formulas shift by the offset; a target larger than the clip tiles it. */
export function pasteClipOps(model: SheetModel, tabId: string, clip: SheetClip, target: Rect): ArtifactOp[] {
  const h = clip.cells.length, w = clip.cells[0]?.length ?? 0;
  if (!h || !w) return [];
  const tr = target.r1 - target.r0 + 1, tc = target.c1 - target.c0 + 1;
  const rows = tr % h === 0 && tr > h ? tr : h;
  const cols = tc % w === 0 && tc > w ? tc : w;
  const ops: ArtifactOp[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const src = clip.cells[r % h][c % w];
      const col = target.c0 + c, row = target.r0 + r;
      const k = cellKey(tabId, col, row);
      if (!src) {
        if (tabData(model, tabId)?.cells.has(cellNum(col, row))) ops.push({ k, del: true });
        continue;
      }
      const fields = { ...src };
      if (typeof fields.input === "string" && isFormula(fields.input)) {
        fields.input = shiftFormula(fields.input, col - (clip.col + (c % w)), row - (clip.rows?.[r % h] ?? clip.row + (r % h)));
      }
      ops.push({ k, put: { kind: "cell", ...fields } });
    }
  return ops;
}

/** Clear a range: contents only (keep styles), or everything. */
export function clearOps(model: SheetModel, tabId: string, rect: Rect, what: "contents" | "all" = "contents"): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t) return [];
  const ops: ArtifactOp[] = [];
  for (const [n, el] of t.cells) {
    const col = n % 32768, row = Math.floor(n / 32768);
    if (col < rect.c0 || col > rect.c1 || row < rect.r0 || row > rect.r1) continue;
    if (what === "all" || !hasStyle(el)) ops.push({ k: el.key, del: true });
    else if (el.input !== undefined) ops.push({ k: el.key, set: { input: null } });
  }
  return ops;
}

export type StylePatch = { [K in keyof CellStyle]?: CellStyle[K] | null };

/** Apply style fields to every cell of a range (null removes a field). */
export function styleOps(model: SheetModel, tabId: string, rect: Rect, patch: StylePatch): ArtifactOp[] {
  const t = tabData(model, tabId);
  const ops: ArtifactOp[] = [];
  const set: Record<string, Json> = {};
  for (const [f, v] of Object.entries(patch)) set[f] = (v ?? null) as Json;
  const putFields: Record<string, Json> = {};
  for (const [f, v] of Object.entries(set)) if (v !== null) putFields[f] = v;
  for (let r = rect.r0; r <= rect.r1; r++)
    for (let c = rect.c0; c <= rect.c1; c++) {
      const k = cellKey(tabId, c, r);
      const el = t?.cells.get(cellNum(c, r));
      if (el) ops.push({ k, set });
      else if (Object.keys(putFields).length) ops.push({ k, put: { kind: "cell", ...putFields } });
    }
  return ops;
}

/** Borders on a range: all cell edges, the outline only, the bottom edge, or none. */
export function borderOps(model: SheetModel, tabId: string, rect: Rect, mode: "all" | "outer" | "bottom" | "none"): ArtifactOp[] {
  const t = tabData(model, tabId);
  const ops: ArtifactOp[] = [];
  for (let r = rect.r0; r <= rect.r1; r++)
    for (let c = rect.c0; c <= rect.c1; c++) {
      let bd = "";
      if (mode === "all") bd = "trbl";
      else if (mode === "outer") bd = (r === rect.r0 ? "t" : "") + (c === rect.c1 ? "r" : "") + (r === rect.r1 ? "b" : "") + (c === rect.c0 ? "l" : "");
      else if (mode === "bottom") bd = r === rect.r1 ? "b" : "";
      const k = cellKey(tabId, c, r);
      const el = t?.cells.get(cellNum(c, r));
      if (el) {
        if ((el.bd ?? "") !== bd) ops.push({ k, set: { bd: bd || null } });
      } else if (bd) ops.push({ k, put: { kind: "cell", bd } });
    }
  return ops;
}

// ── Fill handle ─────────────────────────────────────────────────────────────

/**
 * Drag the fill handle from `src` to cover `dest` (which contains src and
 * extends it along one axis). Numbers with two or more source cells continue
 * as a linear series; text ending in a number counts up; anything else
 * repeats, with formulas shifted like a copy.
 */
export function fillOps(model: SheetModel, tabId: string, src: Rect, dest: Rect): ArtifactOp[] {
  const t = tabData(model, tabId);
  const vertical = dest.r0 !== src.r0 || dest.r1 !== src.r1;
  const ops: ArtifactOp[] = [];
  const lanes = vertical ? [src.c0, src.c1] : [src.r0, src.r1];
  const along = vertical ? [src.r0, src.r1] : [src.c0, src.c1];
  const destAlong = vertical ? [dest.r0, dest.r1] : [dest.c0, dest.c1];
  const len = along[1] - along[0] + 1;
  const at = (lane: number, i: number) => (vertical ? t?.cells.get(cellNum(lane, i)) : t?.cells.get(cellNum(i, lane)));
  for (let lane = lanes[0]; lane <= lanes[1]; lane++) {
    const seq = Array.from({ length: len }, (_, j) => at(lane, along[0] + j));
    const inputs = seq.map((el) => (typeof el?.input === "string" ? el.input : ""));
    const nums = inputs.map((s) => (s && !isFormula(s) ? parseLiteral(s).value : null));
    // One date steps by a day, as in Google and Excel; one plain number copies.
    const oneDate = len === 1 && typeof nums[0] === "number" && /^date/.test(parseLiteral(inputs[0]).implied?.nf ?? "");
    const allNum = (len >= 2 || oneDate) && nums.every((v) => typeof v === "number");
    const names = inputs.map(nameInSeries);
    const named = names.every((n) => n && n.list === names[0]!.list) ? (names as NonNullable<ReturnType<typeof nameInSeries>>[]) : null;
    let step = oneDate ? 1 : 0;
    if (allNum && !oneDate) {
      const ns = nums as number[];
      // Least-squares step, like Sheets' linear trend.
      const n = ns.length;
      const mx = (n - 1) / 2;
      const my = ns.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0;
      ns.forEach((y, x) => {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) ** 2;
      });
      step = sxx ? sxy / sxx : 0;
    }
    const textNum = inputs.map((s: string) => (s.startsWith("=") ? null : s.match(/^(.*?)(\d+)$/)));
    const countUp = textNum.every((m) => m && Number.isNaN(Number(m[0]))) && textNum.every((m) => m![1] === textNum[0]![1]);
    for (let i = destAlong[0]; i <= destAlong[1]; i++) {
      if (i >= along[0] && i <= along[1]) continue;
      const offset = i - along[0];
      const j = ((offset % len) + len) % len;
      const source = seq[j];
      const col = vertical ? lane : i, row = vertical ? i : lane;
      const k = cellKey(tabId, col, row);
      const fields: Record<string, Json> = source ? withoutComment(fieldsOf(source)) : {};
      if (named) {
        const list = SERIES[named[0].list];
        const by = len >= 2 ? named[1].at - named[0].at : 1;
        const at = (((named[0].at + by * offset) % list.length) + list.length) % list.length;
        fields.input = named[0].cased(list[at]);
      } else if (allNum) {
        const ns = nums as number[];
        const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
        const v = mean + step * (offset - (ns.length - 1) / 2);
        fields.input = String(Number(v.toPrecision(12)));
        // Typed 10%, $5 or a date continue as percents, currency, dates.
        const implied = parseLiteral(inputs[j]).implied;
        if (implied && fields.nf === undefined) {
          fields.nf = implied.nf;
          if (implied.dp !== undefined) fields.dp = implied.dp;
        }
      } else if (countUp && len >= 1) {
        const ms = textNum as RegExpMatchArray[];
        const first = Number(ms[0][2]);
        const stepT = len >= 2 ? Number(ms[1][2]) - first : 1;
        const width = ms[0][2].length;
        const nextNum = first + stepT * offset;
        fields.input = ms[0][1] + (ms[0][2].startsWith("0") ? String(nextNum).padStart(width, "0") : String(nextNum));
      } else if (typeof fields.input === "string" && isFormula(fields.input)) {
        const srcIdx = along[0] + j;
        fields.input = shiftFormula(fields.input, vertical ? 0 : i - srcIdx, vertical ? i - srcIdx : 0);
      }
      if (!source && !t?.cells.has(cellNum(col, row))) continue;
      ops.push(source || allNum ? { k, put: { kind: "cell", ...fields } } : { k, del: true });
    }
  }
  return ops;
}

/** Month and weekday names that fill as a series (Jan, Feb… / Monday, Tuesday…). */
const SERIES = {
  mon: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  month: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  weekday: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};

function nameInSeries(text: string): { list: keyof typeof SERIES; at: number; cased: (s: string) => string } | null {
  const t = text.trim();
  for (const list of Object.keys(SERIES) as Array<keyof typeof SERIES>) {
    const at = SERIES[list].findIndex((n) => n.toLowerCase() === t.toLowerCase());
    if (at < 0) continue;
    const cased = t === t.toUpperCase() ? (s: string) => s.toUpperCase() : t === t.toLowerCase() ? (s: string) => s.toLowerCase() : (s: string) => s;
    return { list, at, cased };
  }
  return null;
}

// ── Insert / delete rows and columns ────────────────────────────────────────

/**
 * Insert (count > 0, before `at`) or delete (count < 0, starting at `at`)
 * rows or columns in a tab: moves the tab's cells, widths and heights,
 * rewrites every formula in every tab that points into it, and moves
 * conditional colors and tables.
 */
export function structuralOps(model: SheetModel, tabId: string, axis: "row" | "col", at: number, count: number): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t || count === 0) return [];
  const s: Structural = { tabName: t.meta.name, axis, at, count };
  const lo = at, hi = count < 0 ? at - count - 1 : at - 1;
  const move = (v: number): number | null => {
    if (count > 0) return v >= at ? v + count : v;
    if (v < lo) return v;
    if (v <= hi) return null;
    return v + count;
  };
  const puts = new Map<string, ArtifactOp>();
  const dels = new Set<string>();
  // Moved/deleted cells of this tab.
  for (const [n, el] of t.cells) {
    const col = n % 32768, row = Math.floor(n / 32768);
    const idx = axis === "row" ? row : col;
    const next = move(idx);
    const fields = fieldsOf(el);
    if (typeof fields.input === "string") fields.input = adjustFormula(fields.input, t.meta.name, s);
    if (next === null) {
      dels.add(el.key);
      continue;
    }
    const k = axis === "row" ? cellKey(tabId, col, next) : cellKey(tabId, next, row);
    if (k !== el.key || fields.input !== el.input) {
      puts.set(k, { k, put: { kind: "cell", ...fields } });
      if (k !== el.key) dels.add(el.key);
    }
  }
  // Widths / heights.
  const sizes = axis === "row" ? t.rowHeights : t.colWidths;
  for (const [idx, size] of sizes) {
    const next = move(idx);
    const oldK = axis === "row" ? rowKey(tabId, idx) : colKey(tabId, idx);
    if (next === null) {
      dels.add(oldK);
      continue;
    }
    if (next === idx) continue;
    const k = axis === "row" ? rowKey(tabId, next) : colKey(tabId, next);
    puts.set(k, { k, put: axis === "row" ? { kind: "row", h: size } : { kind: "col", w: size } });
    dels.add(oldK);
  }
  // Formulas in other tabs that point here.
  for (const [otherId, other] of model.byId) {
    if (otherId === tabId) continue;
    for (const el of other.cells.values()) {
      if (typeof el.input !== "string" || !isFormula(el.input)) continue;
      const next = adjustFormula(el.input, other.meta.name, s);
      if (next !== el.input) puts.set(el.key, { k: el.key, set: { input: next } });
    }
  }
  // Conditional colors, tables and validations.
  for (const item of [...model.conds, ...model.tables, ...model.validations, ...model.merges]) {
    if (item.tab !== tabId) continue;
    const next = adjustRangeText(rectA1(item.rect), { axis, at, count });
    if (next === null) dels.add(item.key);
    else if (next !== rectA1(item.rect)) puts.set(item.key, { k: item.key, set: { range: next } });
  }
  // The filter block and frozen panes move with the rows/columns they cover.
  const patch: Record<string, Json> = {};
  const f = t.meta.filter;
  if (f && axis === "row" && f.row >= at) {
    const next = move(f.row);
    patch.filter = next === null ? null : ({ ...f, row: next } as unknown as Json);
  }
  if (f && axis === "col") {
    const span = (a: number, b: number): [number, number] | null => {
      const kept = [];
      for (let c = a; c <= b; c++) {
        const n = move(c);
        if (n !== null) kept.push(n);
      }
      if (!kept.length) return null;
      // An insert inside the block widens it.
      return [Math.min(...kept), count > 0 ? Math.max(...kept) : Math.max(...kept)];
    };
    const next = span(f.c0, f.c1);
    if (!next) patch.filter = null;
    else {
      const hidden: Record<string, string[]> = {};
      for (const [c, vals] of Object.entries(f.hidden ?? {})) {
        const n = move(Number(c));
        if (n !== null) hidden[String(n)] = vals;
      }
      patch.filter = { ...f, c0: next[0], c1: count > 0 && f.c1 >= at ? f.c1 + count : next[1], hidden } as unknown as Json;
    }
  }
  const frozen = axis === "row" ? t.meta.frozenRows : t.meta.frozenCols;
  if (frozen > 0 && at <= frozen) {
    const next = count > 0 ? frozen + count : Math.max(0, frozen - (Math.min(frozen, hi) - lo + 1));
    patch[axis === "row" ? "frozen_rows" : "frozen_cols"] = next || null;
  }
  if (Object.keys(patch).length) for (const op of tabPatchOps(model, tabId, patch)) puts.set(op.k, op);
  const ops: ArtifactOp[] = [];
  for (const k of dels) if (!puts.has(k)) ops.push({ k, del: true });
  ops.push(...puts.values());
  return ops;
}

// ── Sort ────────────────────────────────────────────────────────────────────

/** Sort the rows of a range by one column's evaluated values. Empty values sort last; formulas move with their row. */
export function sortOps(model: SheetModel, wb: Workbook, tabId: string, rect: Rect, byCol: number, desc = false): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t) return [];
  const rows: number[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) rows.push(r);
  const keyOf = (r: number): Scalar => wb.value(tabId, byCol, r);
  const order = [...rows].sort((a, b) => {
    const va = keyOf(a), vb = keyOf(b);
    if (va === null || va === "") return vb === null || vb === "" ? a - b : 1;
    if (vb === null || vb === "") return -1;
    const c = compareScalars(va, vb);
    return (desc ? -c : c) || a - b;
  });
  const ops: ArtifactOp[] = [];
  order.forEach((fromRow, i) => {
    const toRow = rect.r0 + i;
    if (fromRow === toRow) return;
    for (let c = rect.c0; c <= rect.c1; c++) {
      const src = t.cells.get(cellNum(c, fromRow));
      const k = cellKey(tabId, c, toRow);
      if (!src) {
        if (t.cells.has(cellNum(c, toRow))) ops.push({ k, del: true });
        continue;
      }
      const fields = fieldsOf(src);
      if (typeof fields.input === "string" && isFormula(fields.input)) fields.input = shiftFormula(fields.input, 0, toRow - fromRow);
      ops.push({ k, put: { kind: "cell", ...fields } });
    }
  });
  return ops;
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export function addTabOps(model: SheetModel, name: string, extra: Record<string, Json> = {}): { id: string; ops: ArtifactOp[] } {
  const id = newTabId(model.byId.keys());
  const order = Math.max(-1, ...model.tabs.map((t) => t.order)) + 1;
  return { id, ops: [{ k: tabKey(id), put: { kind: "tab", name: uniqueTabName(model, name), order, ...extra } }] };
}

/** Tabs in a new order: every tab's order rewritten to its place, so ties can't leave two tabs in one slot. */
function reorderOps(model: SheetModel, ids: string[]): ArtifactOp[] {
  return ids.flatMap((id, i) => (model.byId.get(id)?.meta.order === i ? [] : tabPatchOps(model, id, { order: i })));
}

/** Move a tab one place left (-1) or right (+1) in the strip. */
export function moveTabOps(model: SheetModel, tabId: string, dir: -1 | 1): ArtifactOp[] {
  const i = model.tabs.findIndex((t) => t.id === tabId);
  return i < 0 ? [] : moveTabToOps(model, tabId, i + dir);
}

/** Put a tab at a place in the strip (a drag). */
export function moveTabToOps(model: SheetModel, tabId: string, to: number): ArtifactOp[] {
  const ids = model.tabs.map((t) => t.id).filter((id) => id !== tabId);
  if (ids.length === model.tabs.length || to < 0 || to > ids.length) return [];
  ids.splice(to, 0, tabId);
  return reorderOps(model, ids);
}

/**
 * A copy of a tab placed right after it: its cells, widths, heights, hidden
 * lines, rules, tables, dropdowns and merges. Comment threads stay on the
 * original. A live query tab copies as a live query.
 */
export function duplicateTabOps(model: SheetModel, tabId: string): { id: string; ops: ArtifactOp[] } {
  const t = tabData(model, tabId);
  if (!t) return { id: tabId, ops: [] };
  const id = newTabId(model.byId.keys());
  const m = t.meta;
  const ops: ArtifactOp[] = [{
    k: tabKey(id),
    put: {
      kind: "tab",
      name: uniqueTabName(model, `${m.name} copy`),
      order: m.order,
      ...(m.frozenRows ? { frozen_rows: m.frozenRows } : {}),
      ...(m.frozenCols ? { frozen_cols: m.frozenCols } : {}),
      ...(m.filter ? { filter: m.filter as unknown as Json } : {}),
      ...(m.query ? { query: m.query as unknown as Json } : {}),
    },
  }];
  for (const [n, el] of t.cells) ops.push({ k: cellKey(id, n % 32768, Math.floor(n / 32768)), put: { kind: "cell", ...withoutComment(fieldsOf(el)) } });
  const cols = new Set([...t.colWidths.keys(), ...(t.hiddenCols ?? [])]);
  for (const c of cols) ops.push({ k: colKey(id, c), put: { kind: "col", ...(t.colWidths.has(c) ? { w: t.colWidths.get(c)! } : {}), ...(t.hiddenCols?.has(c) ? { hidden: true } : {}) } });
  const rows = new Set([...t.rowHeights.keys(), ...(t.hiddenRows ?? [])]);
  for (const r of rows) ops.push({ k: rowKey(id, r), put: { kind: "row", ...(t.rowHeights.has(r) ? { h: t.rowHeights.get(r)! } : {}), ...(t.hiddenRows?.has(r) ? { hidden: true } : {}) } });
  for (const c of model.conds) if (c.tab === tabId) ops.push({ k: newElementKey("cf"), put: { kind: "cf", tab: id, range: rectA1(c.rect), rule: c.rule, ...(c.value !== undefined ? { value: c.value } : {}), ...(c.color ? { color: c.color } : {}) } });
  for (const x of model.tables) if (x.tab === tabId) ops.push({ k: newElementKey("tbl"), put: { kind: "table", tab: id, range: rectA1(x.rect), color: x.color, banded: x.banded } });
  for (const v of model.validations) if (v.tab === tabId) ops.push({ k: newElementKey("dv"), put: { kind: "dv", tab: id, range: rectA1(v.rect), rule: v.rule, ...(v.rule === "list" ? { options: v.options as unknown as Json } : {}), ...(v.strict ? { strict: true } : {}) } });
  for (const g of model.merges) if (g.tab === tabId) ops.push({ k: newElementKey("mg"), put: { kind: "merge", tab: id, range: rectA1(g.rect) } });
  // Right after the original in the strip: the copy takes the next slot and the tabs after it shift.
  const ids = model.tabs.map((x) => x.id);
  const at = ids.indexOf(tabId) + 1;
  (ops[0] as { put: Record<string, Json> }).put.order = at;
  ids.forEach((x, i) => {
    const want = i < at ? i : i + 1;
    if (model.byId.get(x)?.meta.order !== want) ops.push(...tabPatchOps(model, x, { order: want }));
  });
  return { id, ops };
}

export function uniqueTabName(model: SheetModel, name: string): string {
  const taken = new Set(model.tabs.map((t) => t.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** Rename a tab and every formula reference to it. */
export function renameTabOps(model: SheetModel, tabId: string, name: string): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t) return [];
  const old = t.meta.name;
  const ops: ArtifactOp[] = tabPatchOps(model, tabId, { name });
  for (const other of model.byId.values())
    for (const el of other.cells.values()) {
      if (typeof el.input !== "string" || !isFormula(el.input)) continue;
      const next = renameTabInFormula(el.input, old, name);
      if (next !== el.input) ops.push({ k: el.key, set: { input: next } });
    }
  return ops;
}

/** Delete a tab and everything on it. */
export function deleteTabOps(model: SheetModel, tabId: string): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t) return [];
  const ops: ArtifactOp[] = [{ k: tabKey(tabId), del: true }];
  for (const el of t.cells.values()) ops.push({ k: el.key, del: true });
  for (const c of t.colWidths.keys()) ops.push({ k: colKey(tabId, c), del: true });
  for (const r of t.rowHeights.keys()) ops.push({ k: rowKey(tabId, r), del: true });
  for (const item of [...model.conds, ...model.tables, ...model.validations, ...model.merges]) if (item.tab === tabId) ops.push({ k: item.key, del: true });
  return ops;
}

/**
 * Change a tab's fields. Written as a whole put, because the first tab of a
 * new sheet may exist only implicitly (cells under Sheet1, no tab element).
 */
export function tabPatchOps(model: SheetModel, tabId: string, patch: Record<string, Json>): ArtifactOp[] {
  const m = model.byId.get(tabId)?.meta;
  const base: Record<string, Json> = {
    name: m?.name ?? tabId,
    order: m?.order ?? 0,
    ...(m?.frozenRows ? { frozen_rows: m.frozenRows } : {}),
    ...(m?.frozenCols ? { frozen_cols: m.frozenCols } : {}),
    ...(m?.filter ? { filter: m.filter as unknown as Json } : {}),
    ...(m?.query ? { query: m.query as unknown as Json } : {}),
    ...(m?.refreshedAt ? { refreshed_at: m.refreshedAt } : {}),
    ...(m?.queryError ? { query_error: m.queryError } : {}),
    ...(m?.pinned?.length ? { pinned: m.pinned } : {}),
  };
  for (const [f, v] of Object.entries(patch)) {
    if (v === null) delete base[f];
    else base[f] = v;
  }
  return [{ k: tabKey(tabId), put: { kind: "tab", ...base } }];
}

export function colWidthOps(tabId: string, cols: number[], w: number): ArtifactOp[] {
  return cols.map((c) => ({ k: colKey(tabId, c), put: { kind: "col", w: Math.round(w) } }));
}

export function rowHeightOps(tabId: string, rows: number[], h: number): ArtifactOp[] {
  return rows.map((r) => ({ k: rowKey(tabId, r), put: { kind: "row", h: Math.round(h) } }));
}

/** Range text for a rect, for cf/tbl elements. */
export { rectA1, normRect, colLetters, parseKey };

// ── Live query tabs ─────────────────────────────────────────────────────────

/**
 * The ops that make a query tab show `grid` (header row first): changed
 * inputs are set (a cell's style survives), cells past the new data are
 * cleared, and the tab is stamped refreshed. Unchanged cells write nothing.
 */
export function queryTabOps(model: SheetModel, tabId: string, grid: string[][], now: number, error?: string): ArtifactOp[] {
  const t = tabData(model, tabId);
  const ops: ArtifactOp[] = [];
  const want = new Map<number, string>();
  grid.forEach((line, r) => line.forEach((input, c) => input !== "" && want.set(cellNum(c + 1, r + 1), input)));
  if (!error) {
    for (const [n, input] of want) {
      const col = n % 32768, row = Math.floor(n / 32768);
      const el = t?.cells.get(n);
      const k = cellKey(tabId, col, row);
      const header = row === 1;
      if (!el) ops.push({ k, put: header ? { kind: "cell", input, b: true } : { kind: "cell", input } });
      else if (el.input !== input || (header && el.b === undefined)) ops.push({ k, set: header && el.b === undefined ? { input, b: true } : { input } });
    }
    // Columns size to their content the first time they fill; a width someone set stays.
    const widths = new Map<number, number>();
    grid.slice(0, 200).forEach((line) => line.forEach((v, c) => widths.set(c + 1, Math.max(widths.get(c + 1) ?? 0, v.length))));
    for (const [col, chars] of widths) {
      if (t?.colWidths.has(col)) continue;
      ops.push({ k: colKey(tabId, col), put: { kind: "col", w: Math.max(72, Math.min(420, Math.round(chars * 7.6 + 22))) } });
    }
    for (const [n, el] of t?.cells ?? []) {
      if (want.has(n) || el.input === undefined) continue;
      ops.push(hasStyle(el) ? { k: el.key, set: { input: null } } : { k: el.key, del: true });
    }
  }
  ops.push(...tabPatchOps(model, tabId, { refreshed_at: now, query_error: error ?? null }));
  return ops;
}

// ── Cut and paste: a move ───────────────────────────────────────────────────

/**
 * Move a block within a tab (cut + paste). The cells keep their formulas as
 * written, and every reference anywhere that pointed into the block (a cell,
 * or a range wholly inside it) follows it to the new place, like Sheets. The
 * vacated cells clear and whatever stood under the destination is replaced.
 */
export function moveOps(model: SheetModel, tabId: string, src: Rect, destCol: number, destRow: number, destTabId: string = tabId): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t) return [];
  const dt = tabData(model, destTabId);
  const destName = dt?.meta.name ?? destTabId;
  const crossTab = destTabId !== tabId;
  const dc = destCol - src.c0, dr = destRow - src.r0;
  if (dc === 0 && dr === 0 && !crossTab) return [];
  const dest: Rect = { c0: src.c0 + dc, r0: src.r0 + dr, c1: src.c1 + dc, r1: src.r1 + dr };
  const inSrc = (c: number, r: number) => c >= src.c0 && c <= src.c1 && r >= src.r0 && r <= src.r1;
  const name = t.meta.name.toLowerCase();
  /** Rewrite one formula; `formulaTab` is where it lives after the move, `homeTab` where its bare refs pointed before. */
  const follow = (input: string, homeTab: string, formulaTab: string) =>
    mapFormulaRefs(input, (tok) => {
      const target = tok.tab ?? homeTab;
      const b = tok.b ?? tok.a;
      const into = target.toLowerCase() === name && tok.shape !== "cols" && tok.shape !== "rows" && inSrc(tok.a.col, tok.a.row) && inSrc(b.col, b.row);
      if (into) {
        const moved = { ...tok, a: { ...tok.a, col: tok.a.col + dc, row: tok.a.row + dr }, b: tok.b ? { ...tok.b, col: tok.b.col + dc, row: tok.b.row + dr } : undefined };
        return refText({ ...moved, tab: destName.toLowerCase() === formulaTab.toLowerCase() ? undefined : destName });
      }
      // A bare reference in a formula that changed tabs keeps pointing at its old tab.
      if (tok.tab === undefined && homeTab.toLowerCase() !== formulaTab.toLowerCase()) return refText({ ...tok, tab: homeTab });
      return null;
    });
  const puts = new Map<string, ArtifactOp>();
  const dels = new Set<string>();
  for (const [n, el] of dt?.cells ?? []) {
    const col = n % 32768, row = Math.floor(n / 32768);
    if (col >= dest.c0 && col <= dest.c1 && row >= dest.r0 && row <= dest.r1) dels.add(el.key);
  }
  for (const [n, el] of t.cells) {
    const col = n % 32768, row = Math.floor(n / 32768);
    if (!inSrc(col, row)) continue;
    const fields = fieldsOf(el);
    if (typeof fields.input === "string" && isFormula(fields.input)) fields.input = follow(fields.input, t.meta.name, destName);
    const k = cellKey(destTabId, col + dc, row + dr);
    puts.set(k, { k, put: { kind: "cell", ...fields } });
    dels.add(el.key);
  }
  for (const other of model.byId.values())
    for (const [n, el] of other.cells) {
      if (typeof el.input !== "string" || !isFormula(el.input)) continue;
      if (other.meta.id === tabId && inSrc(n % 32768, Math.floor(n / 32768))) continue;
      const next = follow(el.input, other.meta.name, other.meta.name);
      if (next === el.input) continue;
      const pending = puts.get(el.key);
      if (pending && "put" in pending) continue;
      if (!dels.has(el.key)) puts.set(el.key, { k: el.key, set: { input: next } });
    }
  const ops: ArtifactOp[] = [];
  for (const k of dels) if (!puts.has(k)) ops.push({ k, del: true });
  ops.push(...puts.values());
  return ops;
}

// ── Column widths that fit their content ────────────────────────────────────

/** Rough px width of a cell's shown text in the grid font (13px mono, bold a touch wider). */
export function textWidth(text: string, fs = 13, bold = false): number {
  return text.length * 7.6 * (fs / 13) * (bold ? 1.05 : 1) + 22;
}

/**
 * Widths that fit each column's shown values (headers included), capped at
 * 360px. `onlyUnset` leaves columns someone sized alone and never narrows
 * below the default width: that is what an agent's write uses, so its
 * headers and numbers are not clipped.
 */
export function fitWidthOps(model: SheetModel, wb: Workbook, tabId: string, cols: number[], opts: { onlyUnset?: boolean; defaultWidth?: number } = {}): ArtifactOp[] {
  const t = tabData(model, tabId);
  if (!t) return [];
  const want = new Set(cols);
  const widest = new Map<number, number>();
  for (const [n, el] of t.cells) {
    const col = n % 32768;
    if (!want.has(col)) continue;
    const row = Math.floor(n / 32768);
    const info = wb.cell(tabId, col, row);
    if (!info) continue;
    const implied = info.formula && !el.nf ? (inheritedFormat(model, tabId, info.input) ?? info.implied) : info.implied;
    const text = formatValue(info.value, styleOf(el), implied);
    widest.set(col, Math.max(widest.get(col) ?? 0, textWidth(text, typeof el.fs === "number" ? el.fs : 13, !!el.b)));
  }
  // Values an array formula spills into cells with no input of their own count too.
  for (const sp of wb.spillRects(tabId))
    for (let col = sp.c0; col <= sp.c1; col++) {
      if (!want.has(col)) continue;
      for (let row = sp.r0; row <= sp.r1; row++) {
        if (t.cells.has(cellNum(col, row))) continue;
        const text = formatValue(wb.value(tabId, col, row), undefined);
        widest.set(col, Math.max(widest.get(col) ?? 0, textWidth(text, 13, false)));
      }
    }
  const def = opts.defaultWidth ?? 104;
  const ops: ArtifactOp[] = [];
  for (const col of cols) {
    const w = widest.get(col);
    if (w === undefined) continue;
    if (opts.onlyUnset && t.colWidths.has(col)) continue;
    const fit = Math.round(Math.max(opts.onlyUnset ? def : 48, Math.min(360, w)));
    if (opts.onlyUnset && fit <= def) continue;
    ops.push({ k: colKey(tabId, col), put: { kind: "col", w: fit } });
  }
  return ops;
}

/**
 * Imported tables (a CSV, or each sheet of a workbook) as new tabs after the
 * existing ones, names kept unique, columns fitted to what they hold.
 */
/** A table read from a file: its typed cells, and what an .xlsx also carries (cell styles, merges, dropdown lists). */
export type ImportTable = {
  name: string;
  grid: string[][];
  styles?: Array<{ col: number; row: number; style: CellStyle }>;
  merges?: Rect[];
  lists?: Array<{ rect: Rect; values: string[]; strict?: boolean }>;
  /** Ranges that take a date (a date picker). */
  dates?: Array<{ rect: Rect; strict?: boolean }>;
  /** Conditional colors. */
  conds?: Array<{ rect: Rect; rule: CondRule; value?: string | number; color?: string }>;
};

/**
 * A table written with its top-left at col0,row0: the inputs, then what a file
 * or a pasted web table also carries (cell styles, merges, dropdown lists), all
 * moved to the same place. A styled blank cell (a fill alone) is a new cell.
 */
export function placeTableOps(model: SheetModel, tabId: string, col0: number, row0: number, table: Omit<ImportTable, "name">): ArtifactOp[] {
  const cells = gridOps(model, tabId, col0, row0, table.grid);
  const shift = (r: Rect): Rect => ({ c0: r.c0 + col0 - 1, c1: r.c1 + col0 - 1, r0: r.r0 + row0 - 1, r1: r.r1 + row0 - 1 });
  const t = tabData(model, tabId);
  const exists = new Set(cells.filter((o) => "put" in o).map((o) => o.k));
  const styled = (table.styles ?? []).map(({ col, row, style }): ArtifactOp => {
    const c = col + col0 - 1, r = row + row0 - 1;
    const k = cellKey(tabId, c, r);
    return exists.has(k) || t?.cells.has(cellNum(c, r)) ? { k, set: style as CellFields } : { k, put: { kind: "cell", ...(style as CellFields) } };
  });
  const merges = (table.merges ?? []).map((rect) => ({ k: newElementKey("mg"), put: { kind: "merge", tab: tabId, range: rectA1(shift(rect)) } }));
  const lists = (table.lists ?? []).flatMap((l) => validationOps(model, tabId, shift(l.rect), "list", l.values.map((v) => ({ v })), l.strict));
  const dates = (table.dates ?? []).flatMap((x) => validationOps(model, tabId, shift(x.rect), "date", [], x.strict));
  // A rule the sheet can't hold (a value it refuses) is skipped rather than failing the whole import.
  const conds = (table.conds ?? []).flatMap((c) => {
    try {
      return condOps(model, tabId, shift(c.rect), c.rule, c.value, c.color, newElementKey("cf"));
    } catch {
      return [];
    }
  });
  return [...cells, ...styled, ...merges, ...lists, ...dates, ...conds];
}

export function importTablesOps(model: SheetModel, tables: ImportTable[]): { ops: ArtifactOp[]; tabIds: string[] } {
  const ops: ArtifactOp[] = [];
  const tabIds: string[] = [];
  let m = model;
  for (const table of tables) {
    const add = addTabOps(m, table.name);
    const first = add.ops[0];
    const name = "put" in first && typeof first.put.name === "string" ? first.put.name : table.name;
    const meta: TabMeta = { id: add.id, name, order: Math.max(-1, ...m.tabs.map((t) => t.order)) + 1, frozenRows: 0, frozenCols: 0 };
    m = { ...m, tabs: [...m.tabs, meta], byId: new Map(m.byId).set(add.id, { meta, cells: new Map(), colWidths: new Map(), rowHeights: new Map(), rows: 0, cols: 0 }) };
    const cells = placeTableOps(m, add.id, 1, 1, table);
    // Fit against the imported cells alone: the new tab holds nothing else yet.
    const alone = buildModel([...foldOps(new Map(), [...add.ops, ...cells])].map(([k, st]) => toElement(k, st)));
    const width = Math.max(0, ...table.grid.map((r) => r.length));
    const fit = fitWidthOps(alone, workbookFor(alone), add.id, Array.from({ length: Math.min(width, 200) }, (_, i) => i + 1));
    ops.push(...add.ops, ...cells, ...fit);
    tabIds.push(add.id);
  }
  return { ops, tabIds };
}

/**
 * Find and replace: every occurrence of `find` (any case) in the typed text of
 * a tab's cells, or of one cell. Formulas are left alone, so a replace never
 * rewrites references. Returns the ops and how many cells changed.
 */
export function replaceOps(model: SheetModel, tabId: string, find: string, replacement: string, only?: { col: number; row: number }): { ops: ArtifactOp[]; count: number } {
  const t = tabData(model, tabId);
  if (!t || !find) return { ops: [], count: 0 };
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const cells: Array<{ col: number; row: number; input: string }> = [];
  for (const [n, el] of t.cells) {
    const col = n % 32768, row = Math.floor(n / 32768);
    if (only && (only.col !== col || only.row !== row)) continue;
    if (typeof el.input !== "string" || el.input.startsWith("=") || !re.test(el.input)) continue;
    re.lastIndex = 0;
    cells.push({ col, row, input: el.input.replace(re, () => replacement) });
  }
  return { ops: inputOps(model, tabId, cells), count: cells.length };
}
