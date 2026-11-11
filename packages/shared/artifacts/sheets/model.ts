// The sheet document as elements, and the structure read from them. One
// sheet doc holds tabs; each tab holds cells (input + style), column widths,
// row heights, conditional colors and table styles:
//
//   tab:<id>          {name, order, frozen_rows?, frozen_cols?, filter?, query?, refreshed_at?}
//   c:<tab>!<A1>      {input?, nf?, dp?, sign?, cur?, b?, i?, u?, fs?, al?, color?, fill?, bd?, wrap?}
//   col:<tab>!<C>     {w}
//   row:<tab>!<n>     {h}
//   cf:<id>           {tab, range, rule, value?, color?}   conditional color
//   tbl:<id>          {tab, range, color, banded?}          banded table style
//   dv:<id>           {tab, range, rule, options?, strict?} data validation (dropdown chips, dates)
import type { ArtifactElement } from "../core";
import { Workbook } from "./engine";
import { isError, parseLiteral, type ImpliedFormat, type Scalar } from "./values";
import { parseFormula, type Node } from "./formula";
import { DEFAULT_TAB, a1, parseKey, parseQualifiedRange, parseRectA1, rectA1, type Rect } from "./refs";
import type { CellNumberFormat } from "./format";

export const PALETTE = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const;
export type PaletteColor = (typeof PALETTE)[number];

export type CellStyle = CellNumberFormat & {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** Font size in px. */
  fs?: number;
  al?: "left" | "center" | "right";
  color?: PaletteColor;
  fill?: PaletteColor;
  /** Borders: any of the letters t r b l. */
  bd?: string;
  wrap?: boolean;
};

export type CellEl = ArtifactElement & CellStyle & { input?: string };

export const STYLE_FIELDS = ["nf", "dp", "sign", "cur", "b", "i", "u", "fs", "al", "color", "fill", "bd", "wrap"] as const;

export type QuerySource = "tasks" | "sessions" | "prs" | "metrics";
export type TabQuery = { source: QuerySource; project?: string; status?: string; limit?: number };

export type TabFilter = {
  /** Header row of the filtered block; data starts below it. */
  row: number;
  c0: number;
  c1: number;
  /** Per column index, the display values that are hidden. */
  hidden: Record<string, string[]>;
};

export type TabMeta = {
  id: string;
  name: string;
  order: number;
  frozenRows: number;
  frozenCols: number;
  filter?: TabFilter;
  query?: TabQuery;
  refreshedAt?: number;
  queryError?: string;
};

export type CondRule = "sign" | "scale" | "gt" | "lt" | "eq" | "contains";
export type CondFormat = { key: string; tab: string; rect: Rect; rule: CondRule; value?: string | number; color?: PaletteColor };
export type TableStyle = { key: string; tab: string; rect: Rect; color: PaletteColor; banded: boolean };

/** One choice of a dropdown, with the chip color it paints. */
export type ValidationOption = { v: string; color?: PaletteColor };
/**
 * What a range accepts: one of a list (drawn as colored chips with a
 * dropdown) or a date (a date picker). Strict refuses anything else on entry;
 * otherwise a value outside the list is kept and flagged.
 */
export type Validation = { key: string; tab: string; rect: Rect; rule: "list" | "date"; options: ValidationOption[]; strict: boolean };

/** Element kinds that style a range rather than hold a cell: they live outside the tab's cell maps. */
export const RANGE_KINDS: ReadonlySet<string> = new Set(["cf", "table", "dv"]);

/** The validation covering a cell, if any (the last written wins on overlap). */
export function validationAt(model: SheetModel, tabId: string, col: number, row: number): Validation | undefined {
  for (let i = model.validations.length - 1; i >= 0; i--) {
    const v = model.validations[i];
    if (v.tab === tabId && col >= v.rect.c0 && col <= v.rect.c1 && row >= v.rect.r0 && row <= v.rect.r1) return v;
  }
  return undefined;
}

function toOptions(raw: unknown): ValidationOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (typeof o === "string" ? { v: o } : o && typeof o === "object" && typeof (o as any).v === "string" ? { v: (o as any).v, color: (PALETTE as readonly string[]).includes((o as any).color) ? (o as any).color : undefined } : null))
    .filter((o): o is ValidationOption => !!o && o.v !== "");
}

export type TabData = {
  meta: TabMeta;
  cells: Map<number, CellEl>;
  colWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  rows: number;
  cols: number;
  /** The newest cell an agent session wrote here: tab labels show agent activity on tabs nobody is looking at. */
  agentWrite?: AgentWrite;
};

export type AgentWrite = { rev: number; by: string; at?: number };

/** Fold a cell write into its tab's newest agent write. */
function noteAgentWrite(t: TabData, el: ArtifactElement): void {
  if (typeof el.by === "string" && el.by.startsWith("s:") && el.rev > (t.agentWrite?.rev ?? -1)) t.agentWrite = { rev: el.rev, by: el.by, at: el.at };
}

export type SheetModel = {
  tabs: TabMeta[];
  byId: Map<string, TabData>;
  conds: CondFormat[];
  tables: TableStyle[];
  validations: Validation[];
};

/** Cells are stored per tab under row * 2^15 + col. */
export function cellNum(col: number, row: number): number {
  return row * 32768 + col;
}

export function buildModel(elements: readonly ArtifactElement[]): SheetModel {
  const byId = new Map<string, TabData>();
  const tabFor = (id: string): TabData => {
    let t = byId.get(id);
    if (!t) {
      t = { meta: { id, name: id, order: Number.MAX_SAFE_INTEGER, frozenRows: 0, frozenCols: 0 }, cells: new Map(), colWidths: new Map(), rowHeights: new Map(), rows: 0, cols: 0 };
      byId.set(id, t);
    }
    return t;
  };
  const conds: CondFormat[] = [];
  const tables: TableStyle[] = [];
  const validations: Validation[] = [];
  for (const el of elements) {
    if (RANGE_KINDS.has(el.kind)) {
      const rect = typeof el.range === "string" ? parseRectA1(el.range) : null;
      if (!rect || typeof el.tab !== "string") continue;
      if (el.kind === "dv") validations.push({ key: el.key, tab: el.tab, rect, rule: el.rule === "date" ? "date" : "list", options: toOptions(el.options), strict: el.strict === true });
      else if (el.kind === "cf") conds.push({ key: el.key, tab: el.tab, rect, rule: (el.rule as CondRule) ?? "sign", value: el.value as any, color: el.color as PaletteColor | undefined });
      else tables.push({ key: el.key, tab: el.tab, rect, color: (el.color as PaletteColor) ?? "blue", banded: el.banded !== false });
      continue;
    }
    const k = parseKey(el.key);
    if (!k) continue;
    const t = tabFor(k.tab);
    switch (k.type) {
      case "tab":
        t.meta = {
          id: k.tab,
          name: typeof el.name === "string" && el.name ? el.name : k.tab,
          order: typeof el.order === "number" ? el.order : 0,
          frozenRows: typeof el.frozen_rows === "number" ? el.frozen_rows : 0,
          frozenCols: typeof el.frozen_cols === "number" ? el.frozen_cols : 0,
          filter: (el.filter as TabFilter | undefined) ?? undefined,
          query: (el.query as TabQuery | undefined) ?? undefined,
          refreshedAt: typeof el.refreshed_at === "number" ? el.refreshed_at : undefined,
          queryError: typeof el.query_error === "string" ? el.query_error : undefined,
        };
        break;
      case "cell":
        t.cells.set(cellNum(k.col, k.row), el as CellEl);
        noteAgentWrite(t, el);
        if (k.row > t.rows) t.rows = k.row;
        if (k.col > t.cols) t.cols = k.col;
        break;
      case "col":
        if (typeof el.w === "number") t.colWidths.set(k.col, el.w);
        break;
      case "row":
        if (typeof el.h === "number") t.rowHeights.set(k.row, el.h);
        break;
    }
  }
  if (byId.size === 0) tabFor(DEFAULT_TAB).meta.order = 0;
  const tabs = [...byId.values()].map((t) => t.meta).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { tabs, byId, conds, tables, validations };
}

export function tabByName(model: SheetModel, name: string): TabMeta | undefined {
  const lower = name.toLowerCase();
  return model.tabs.find((t) => t.name.toLowerCase() === lower) ?? model.tabs.find((t) => t.id.toLowerCase() === lower);
}

/** Load (or sync) a workbook from a model. Pass the previous model to update only what changed. */
export function syncWorkbook(wb: Workbook, model: SheetModel, prev?: SheetModel): void {
  wb.setTabs(model.tabs.map((t) => ({ id: t.id, name: t.name })));
  const changes: Array<{ tab: string; col: number; row: number; input: string | null }> = [];
  for (const [id, t] of model.byId) {
    const before = prev?.byId.get(id);
    for (const [n, el] of t.cells) {
      const old = before?.cells.get(n);
      if (old === el || (old && old.input === el.input)) continue;
      changes.push({ tab: id, col: n % 32768, row: Math.floor(n / 32768), input: typeof el.input === "string" ? el.input : null });
    }
    if (before)
      for (const n of before.cells.keys())
        if (!t.cells.has(n)) changes.push({ tab: id, col: n % 32768, row: Math.floor(n / 32768), input: null });
  }
  if (prev)
    for (const [id, t] of prev.byId)
      if (!model.byId.has(id)) for (const n of t.cells.keys()) changes.push({ tab: id, col: n % 32768, row: Math.floor(n / 32768), input: null });
  wb.update(changes);
}

export function workbookFor(model: SheetModel): Workbook {
  const wb = new Workbook();
  syncWorkbook(wb, model);
  return wb;
}

/** Resolve "Tab!A1:D20" (tab by name or id) or "A1:D20" (first tab). */
export function resolveRange(model: SheetModel, range: string): { tab: TabMeta; rect: Rect } | { error: string } {
  const q = parseQualifiedRange(range);
  if (!q) return { error: `bad range ${range}` };
  const tab = q.tab !== undefined ? tabByName(model, q.tab) : model.tabs[0];
  if (!tab) return { error: `no tab named ${q.tab}` };
  return { tab, rect: q.rect };
}

export type PlainValue = number | string | boolean | null;

/** A value as the read API hands it out: errors as their code, numbers at 15 significant digits (no float noise). */
export function plainValue(v: Scalar): PlainValue {
  if (isError(v)) return v.error;
  if (typeof v === "number") return Number(v.toPrecision(15));
  return v;
}

/**
 * Evaluated values of a range, row-major, empty cells null, errors as their
 * code ("#DIV/0!"). The read API for dashboards and the CLI. A whole-tab read
 * is `readSheetRange(els, "Tab")`-style via readSheetTab.
 */
export function readSheetRange(
  elements: readonly ArtifactElement[],
  range: string,
): { tab: string; rect: string; values: PlainValue[][] } | { error: string } {
  const model = buildModel(elements);
  const r = resolveRange(model, range);
  if ("error" in r) return r;
  const wb = workbookFor(model);
  const t = model.byId.get(r.tab.id)!;
  // Whole columns/rows clip to the used area.
  const rect = { ...r.rect, r1: Math.min(r.rect.r1, Math.max(t.rows, r.rect.r0)), c1: Math.min(r.rect.c1, Math.max(t.cols, r.rect.c0)) };
  const values = wb.read(r.tab.id, rect).map((row) => row.map(plainValue));
  return { tab: r.tab.name, rect: rectA1(rect), values };
}

/** Every used cell of a tab (by name; first tab when omitted), as readSheetRange returns it. */
export function readSheetTab(elements: readonly ArtifactElement[], tabName?: string) {
  const model = buildModel(elements);
  const tab = tabName !== undefined ? tabByName(model, tabName) : model.tabs[0];
  if (!tab) return { error: `no tab named ${tabName}` };
  const t = model.byId.get(tab.id)!;
  if (t.rows === 0) return { tab: tab.name, rect: "A1", values: [] as PlainValue[][] };
  return readSheetRange(elements, `${quoteName(tab.name)}!A1:${a1(t.cols, t.rows)}`);
}

function quoteName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export function styleOf(el: CellEl | undefined): CellStyle {
  if (!el) return {};
  const s: Record<string, unknown> = {};
  for (const f of STYLE_FIELDS) if (el[f] !== undefined) s[f] = el[f];
  return s as CellStyle;
}

// ── Incremental model for the live page ─────────────────────────────────────

/**
 * The model and workbook for a page that receives a fresh element array on
 * every write. One identity pass finds what changed (elements a write did not
 * touch keep their object), so an edit costs the cells it changed, not the
 * sheet: changed cells update their tab in place, the workbook recalculates
 * downstream of them, and only the touched tabs get a new object (so views
 * holding an untouched tab skip their render).
 */
export class LiveSheet {
  model: SheetModel = buildModel([]);
  readonly wb = new Workbook();
  version = 0;
  private byKey = new Map<string, ArtifactElement>();
  private others = new Map<string, ArtifactElement>();
  /** The array the last update read: the store keeps element order, so most slots hold the same object. */
  private last: readonly ArtifactElement[] = [];

  /** Fold in the current elements; returns whether anything changed. */
  update(elements: readonly ArtifactElement[]): boolean {
    const changed: ArtifactElement[] = [];
    let kept = 0;
    const last = this.last;
    this.last = elements;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      // Same object in the same slot: unchanged, no key lookup (a 500k-cell sheet diffs in a few ms).
      if (last[i] === el) {
        kept++;
        continue;
      }
      const prev = this.byKey.get(el.key);
      if (prev === undefined) changed.push(el);
      else {
        kept++;
        if (prev !== el) changed.push(el);
      }
    }
    const removed: ArtifactElement[] = [];
    if (kept !== this.byKey.size) {
      const now = new Set<string>();
      for (const el of elements) now.add(el.key);
      for (const [k, el] of this.byKey) if (!now.has(k)) removed.push(el);
    }
    if (!changed.length && !removed.length) return false;
    if (this.byKey.size === 0 || changed.length + removed.length > elements.length / 2) {
      this.rebuild(elements);
      return true;
    }
    const touched = new Map<string, TabData>();
    const tabOf = (id: string): TabData => {
      let t = touched.get(id);
      if (t) return t;
      const prev = this.model.byId.get(id);
      t = prev
        ? { ...prev }
        : { meta: { id, name: id, order: Number.MAX_SAFE_INTEGER, frozenRows: 0, frozenCols: 0 }, cells: new Map(), colWidths: new Map(), rowHeights: new Map(), rows: 0, cols: 0 };
      touched.set(id, t);
      return t;
    };
    let structure = false;
    const inputs: Array<{ tab: string; col: number; row: number; input: string | null }> = [];
    const visit = (el: ArtifactElement, gone: boolean) => {
      if (gone) this.byKey.delete(el.key);
      else this.byKey.set(el.key, el);
      const k = parseKey(el.key);
      if (!k || k.type === "tab" || RANGE_KINDS.has(el.kind)) {
        if (gone) this.others.delete(el.key);
        else this.others.set(el.key, el);
        structure = true;
        if (k?.type === "tab") tabOf(k.tab);
        return;
      }
      const t = tabOf(k.tab);
      if (k.type === "cell") {
        const n = cellNum(k.col, k.row);
        const before = t.cells.get(n)?.input;
        if (gone) t.cells.delete(n);
        else {
          t.cells.set(n, el as CellEl);
          noteAgentWrite(t, el);
          if (k.row > t.rows) t.rows = k.row;
          if (k.col > t.cols) t.cols = k.col;
        }
        const after = gone ? undefined : (el as CellEl).input;
        if (before !== after) inputs.push({ tab: k.tab, col: k.col, row: k.row, input: typeof after === "string" ? after : null });
      } else if (k.type === "col") {
        if (t.colWidths === this.model.byId.get(k.tab)?.colWidths) t.colWidths = new Map(t.colWidths);
        if (gone || typeof el.w !== "number") t.colWidths.delete(k.col);
        else t.colWidths.set(k.col, el.w);
      } else if (k.type === "row") {
        if (t.rowHeights === this.model.byId.get(k.tab)?.rowHeights) t.rowHeights = new Map(t.rowHeights);
        if (gone || typeof el.h !== "number") t.rowHeights.delete(k.row);
        else t.rowHeights.set(k.row, el.h);
      }
    };
    for (const el of changed) visit(el, false);
    for (const el of removed) visit(el, true);
    const byId = new Map(this.model.byId);
    for (const [id, t] of touched) {
      // A cell on a tab nobody declared still makes a tab; that is a structural change.
      if (!byId.has(id)) structure = true;
      byId.set(id, t);
    }
    let { tabs, conds, tables, validations } = this.model;
    if (structure) {
      // Tab metas, conditional colors and tables come from the few non-cell elements.
      const meta = buildModel([...this.others.values()]);
      for (const [id, t] of byId) {
        const m = meta.byId.get(id)?.meta;
        const next = m ?? { id, name: id, order: Number.MAX_SAFE_INTEGER, frozenRows: 0, frozenCols: 0 };
        if (!sameMeta(t.meta, next)) byId.set(id, { ...t, meta: next });
      }
      // A tab with no element and no cells is gone.
      for (const [id, t] of byId) if (!meta.byId.has(id) && t.cells.size === 0 && t.colWidths.size === 0 && t.rowHeights.size === 0) byId.delete(id);
      if (byId.size === 0) byId.set(DEFAULT_TAB, buildModel([]).byId.get(DEFAULT_TAB)!);
      tabs = [...byId.values()].map((t) => t.meta).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      conds = meta.conds;
      tables = meta.tables;
      validations = meta.validations;
      this.wb.setTabs(tabs.map((t) => ({ id: t.id, name: t.name })));
    }
    this.model = { tabs, byId, conds, tables, validations };
    this.wb.update(inputs);
    this.version++;
    return true;
  }

  /** The clock moved a minute: TODAY()/NOW() and what reads them recalculate. */
  refreshClock(): boolean {
    if (!this.wb.refreshVolatile()) return false;
    this.version++;
    return true;
  }

  private rebuild(elements: readonly ArtifactElement[]): void {
    const prev = this.byKey.size ? this.model : undefined;
    this.model = buildModel(elements);
    syncWorkbook(this.wb, this.model, prev);
    this.byKey = new Map(elements.map((e) => [e.key, e]));
    this.others = new Map();
    for (const el of elements) {
      const k = parseKey(el.key);
      if (!k || k.type === "tab" || RANGE_KINDS.has(el.kind)) this.others.set(el.key, el);
    }
    this.version++;
  }
}

function sameMeta(a: TabMeta, b: TabMeta): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The number format a formula shows when it has none of its own: that of the
 * first cell it reads (=B2*2 over a currency B2 reads as currency), following
 * formula chains a few steps. Sheets does the same.
 */
const FORMAT_KEEPING = new Set(["SUM", "AVERAGE", "MIN", "MAX", "MEDIAN", "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "SUMIF", "SUMIFS", "AVERAGEIF", "AVERAGEIFS", "MAXIFS", "MINIFS", "IF", "IFS", "IFERROR", "IFNA", "XLOOKUP", "VLOOKUP", "HLOOKUP", "INDEX", "CHOOSE", "SWITCH", "EDATE", "EOMONTH", "TODAY", "DATE"]);

/**
 * The number format a formula shows when it has none of its own: that of the
 * cell it reads (=B2*2 over a currency B2 reads as currency), following
 * formula chains a few steps, like Sheets. Only results that keep their
 * input's unit inherit: arithmetic, a reference, and aggregates such as SUM;
 * COUNT, MATCH, comparisons and text do not.
 */
export function inheritedFormat(model: SheetModel, tabId: string, input: string, depth = 0): ImpliedFormat | undefined {
  if (depth > 4 || !input.startsWith("=")) return undefined;
  let ast: Node;
  try {
    ast = parseFormula(input.slice(1));
  } catch {
    return undefined;
  }
  const source = (n: Node): Node | null => {
    switch (n.t) {
      case "ref":
      case "range":
        return n;
      case "neg":
        return source(n.a);
      case "bin":
        if (!["+", "-", "*", "/"].includes(n.op)) return null;
        return source(n.a) ?? source(n.b);
      case "fn":
        if (n.name === "TODAY" || n.name === "DATE") return n;
        if (!FORMAT_KEEPING.has(n.name)) return null;
        // IF(cond, a, b) takes its branches' unit; lookups their return range.
        if (n.name === "IF" || n.name === "IFERROR" || n.name === "IFNA") return source(n.args[n.name === "IF" ? 1 : 0] ?? { t: "empty" });
        if (n.name === "XLOOKUP") return n.args[2] ? source(n.args[2]) : null;
        for (const a of n.args) {
          const s = source(a);
          if (s) return s;
        }
        return null;
      default:
        return null;
    }
  };
  const src = source(ast);
  if (!src) return undefined;
  if (src.t === "fn") return { nf: "date" };
  if (src.t !== "ref" && src.t !== "range") return undefined;
  const tab = src.tab !== undefined ? tabByName(model, src.tab) : model.byId.get(tabId)?.meta;
  if (!tab) return undefined;
  const col = src.t === "ref" ? src.col : src.c0, row = src.t === "ref" ? src.row : src.r0;
  const el = model.byId.get(tab.id)?.cells.get(cellNum(col, row));
  if (!el) return undefined;
  if (el.nf && el.nf !== "plain" && el.nf !== "text" && el.nf !== "check") return { nf: el.nf, dp: el.dp };
  if (typeof el.input !== "string") return undefined;
  if (el.input.startsWith("=")) return inheritedFormat(model, tab.id, el.input, depth + 1);
  return parseLiteral(el.input).implied;
}
