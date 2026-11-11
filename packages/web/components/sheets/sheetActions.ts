// The sheet's pure helpers and the handlers that write through live.apply
// (format, copy, paste), lifted out of SheetView so the view stays readable.
// Handlers read the view's state through SheetCtx, refreshed on every render.
import { createElement } from "react";
import { toast } from "sonner";
import { PasteHint } from "./SheetMenus";
import { Workbook, mergeAt, mergeOps, unmergeOps, condOps, hideOps, parseFormula, validateInput, validationAt, a1, borderOps, cellNum, clearOps, clipOf, formatValue, gridOps, inputOps, moveOps, isFormula, tokenize, newElementKey, normRect, parseQualifiedRange, parseTsv, pasteClipOps, rectA1, sortOps, structuralOps, styleOf, styleOps, tabPatchOps, toTsv, inheritedFormat, shiftFormula, type PaletteColor, type Rect, type SheetClip, type SheetModel, type TabData, type QuerySource } from "./sheetCore";
import { finishInput, type EditStore } from "./editStore";
import type { AxisLayout } from "./layout";
import type { FormatAction } from "./FormatBar";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { LiveHandle } from "../live/useLiveArtifact";
import type { ArtifactOp } from "@codecast/shared/artifacts";

export const DEF_COL_W = 104;
export const DEF_ROW_H = 26;
export const REF_COLORS: PaletteColor[] = ["blue", "magenta", "green", "orange", "violet", "cyan", "red", "yellow"];

export type Sel = { anchor: { col: number; row: number }; focus: { col: number; row: number } };
export type Menu = { kind: "cell" | "colHeader" | "rowHeader"; col: number; row: number } | { kind: "tab"; tabId: string };

/** Internal clipboard: cell fields with their origin, so a paste here shifts formulas. */
let lastClip: { id: string; docId: string; tabId: string; rect: Rect; clip: SheetClip; cut: boolean; text: string } | null = null;
export const CLIP_MIME = "application/x-codecast-sheet";

export function selRect(s: Sel): Rect {
  return normRect({ c0: s.anchor.col, r0: s.anchor.row, c1: s.focus.col, r1: s.focus.row });
}

export function parsePosition(pos: string | undefined): { tab: string; rect: Rect } | null {
  if (!pos) return null;
  const bang = pos.lastIndexOf("!");
  if (bang < 0) return null;
  const q = parseQualifiedRange(`x!${pos.slice(bang + 1)}`);
  return q ? { tab: pos.slice(0, bang), rect: q.rect } : null;
}

/** The selection's visible rows: a filtered range copies what is on screen. */
export function visibleRowsOf(rect: Rect, hidden: Set<number>, maxRow: number): number[] {
  const out: number[] = [];
  for (let r = rect.r0; r <= Math.min(rect.r1, Math.max(maxRow, rect.r0)); r++) if (!hidden.has(r)) out.push(r);
  return out;
}

/** Clear contents of the rows a person can see (a filter's hidden rows stay as they are). */
export function clearVisible(model: SheetModel, tabId: string, rect: Rect, hidden: Set<number>) {
  if (!hidden.size) return clearOps(model, tabId, rect, "contents");
  const ops = [];
  let r = rect.r0;
  while (r <= rect.r1) {
    while (r <= rect.r1 && hidden.has(r)) r++;
    const start = r;
    while (r <= rect.r1 && !hidden.has(r)) r++;
    if (start <= rect.r1 && start < r) ops.push(...clearOps(model, tabId, { ...rect, r0: start, r1: r - 1 }, "contents"));
  }
  return ops;
}

export const QUERY_LABEL: Record<QuerySource, string> = { tasks: "Tasks", sessions: "Sessions", prs: "Pull requests", metrics: "Metrics" };

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function cellNumOfKey(key: string): number {
  const m = key.match(/!([A-Z]+)(\d+)$/)!;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return cellNum(col, Number(m[2]));
}

export function elementsHaveTab(elements: readonly { key: string }[], tabId: string): boolean {
  return elements.some((e) => e.key === `tab:${tabId}`);
}

export function shiftFormulaSafe(input: string, dc: number, dr: number): string {
  return shiftFormula(input, dc, dr);
}

/** The contiguous block of data around a cell (Sheets' "current region"). */
export function dataRegion(tab: TabData, col: number, row: number): Rect {
  const has = (c: number, r: number) => {
    const el = tab.cells.get(cellNum(c, r));
    return !!el && typeof el.input === "string" && el.input !== "";
  };
  let r: Rect = { c0: col, c1: col, r0: row, r1: row };
  for (let grew = true; grew; ) {
    grew = false;
    const tryGrow = (next: Rect, probe: () => boolean) => {
      if (probe()) {
        r = next;
        grew = true;
      }
    };
    tryGrow({ ...r, r1: r.r1 + 1 }, () => range(r.c0, r.c1).some((c) => has(c, r.r1 + 1)));
    if (r.r0 > 1) tryGrow({ ...r, r0: r.r0 - 1 }, () => range(r.c0, r.c1).some((c) => has(c, r.r0 - 1)));
    tryGrow({ ...r, c1: r.c1 + 1 }, () => range(r.r0, r.r1).some((rr) => has(r.c1 + 1, rr)));
    if (r.c0 > 1) tryGrow({ ...r, c0: r.c0 - 1 }, () => range(r.r0, r.r1).some((rr) => has(r.c0 - 1, rr)));
  }
  return r;
}

export function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** A first row of text over a column of numbers reads as a header. */
export function isHeaderRow(wb: Workbook, tabId: string, r: Rect): boolean {
  if (r.r1 <= r.r0) return false;
  let textTop = 0, numBelow = 0;
  for (let c = r.c0; c <= r.c1; c++) {
    if (typeof wb.value(tabId, c, r.r0) === "string") textTop++;
    if (typeof wb.value(tabId, c, r.r0 + 1) === "number") numBelow++;
  }
  return textTop === r.c1 - r.c0 + 1 || (textTop > 0 && numBelow > 0);
}

export function columnValues(wb: Workbook, tab: TabData, col: number, headerRow: number): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (let r = headerRow + 1; r <= tab.rows; r++) {
    const info = wb.cell(tab.meta.id, col, r);
    const text = info ? formatValue(info.value, styleOf(tab.cells.get(cellNum(col, r))), info.implied) : "";
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => (a.text === "" ? 1 : b.text === "" ? -1 : a.text.localeCompare(b.text, undefined, { numeric: true })));
}

/** References in the formula being typed, as "tab|A1:B2;..." so the grid can color them. */
export function refsKeyOf(text: string | undefined): string {
  if (!text || !isFormula(text)) return "";
  try {
    return tokenize(text.slice(1))
      .filter((t): t is Extract<ReturnType<typeof tokenize>[number], { type: "ref" }> => t.type === "ref")
      .slice(0, 12)
      .map((t) => {
        const a = a1(t.a.col, Math.min(t.a.row, 1_000_000));
        const b = t.b ? a1(Math.min(t.b.col, 18_278), Math.min(t.b.row, 100_000)) : null;
        return `${t.tab ?? ""}|${b ? `${a}:${b}` : a}`;
      })
      .join(";");
  } catch {
    return "";
  }
}

export function formatSelection(a: FormatAction, c: SheetCtx) {
  const { S, live, apply } = c;
  const filter = c.S.current.tab.meta.filter;
    const { model, activeTabId, rect, wb, sel, tab } = S.current;
    if (S.current.readOnlyDoc) return;
    // On a live query tab the server owns the contents; formats, filters and freezing still apply.
    if (S.current.readOnly && (a.type === "sort" || a.type === "insert" || a.type === "delete")) {
      toast("This tab is a live query; it fills itself.");
      return;
    }
    const el = tab.cells.get(cellNum(sel.anchor.col, sel.anchor.row));
    const st = styleOf(el);
    switch (a.type) {
      case "style":
        apply(styleOps(model, activeTabId, rect, a.patch as any));
        break;
      case "toggle":
        apply(styleOps(model, activeTabId, rect, { [a.field]: st[a.field] ? null : true } as any));
        break;
      case "decimals": {
        const info = wb.cell(activeTabId, sel.anchor.col, sel.anchor.row);
        const v = info?.value;
        let cur = st.dp ?? info?.implied?.dp;
        if (cur === undefined) {
          const shown = typeof v === "number" ? formatValue(v, st, info?.implied) : "";
          cur = shown.includes(".") ? shown.split(".")[1].replace(/\D/g, "").length : 0;
        }
        // Keep what the number reads as (a typed 10% stays a percent).
        const nf = st.nf ?? info?.implied?.nf ?? (info?.input?.startsWith("=") ? inheritedFormat(model, activeTabId, info.input)?.nf : undefined) ?? "number";
        apply(styleOps(model, activeTabId, rect, { dp: Math.max(0, Math.min(10, cur + a.delta)), nf }));
        break;
      }
      case "border":
        apply(borderOps(model, activeTabId, rect, a.mode));
        break;
      case "cond": {
        if (a.rule === "clear") {
          const hits = model.conds.filter((c) => c.tab === activeTabId && c.rect.c0 <= rect.c1 && c.rect.c1 >= rect.c0 && c.rect.r0 <= rect.r1 && c.rect.r1 >= rect.r0);
          apply(hits.map((c) => ({ k: c.key, del: true as const })));
        } else {
          apply(condOps(model, activeTabId, rect, a.rule, undefined, a.color));
        }
        break;
      }
      case "rules":
        c.openRules();
        break;
      case "merge":
        apply(a.on ? mergeOps(model, activeTabId, rect) : unmergeOps(model, activeTabId, rect));
        break;
      case "table": {
        const hits = model.tables.filter((t) => t.tab === activeTabId && t.rect.c0 <= rect.c1 && t.rect.c1 >= rect.c0 && t.rect.r0 <= rect.r1 && t.rect.r1 >= rect.r0);
        if (!a.color) apply(hits.map((t) => ({ k: t.key, del: true as const })));
        else {
          // A single cell styles the data region around it.
          const r = rect.c0 === rect.c1 && rect.r0 === rect.r1 ? dataRegion(tab, rect.c0, rect.r0) : rect;
          apply([...hits.map((t) => ({ k: t.key, del: true as const })), { k: newElementKey("tbl"), put: { kind: "table", tab: activeTabId, range: rectA1(r), color: a.color, banded: true } }]);
        }
        break;
      }
      case "sort": {
        const region = rect.r0 === rect.r1 ? dataRegion(tab, rect.c0, rect.r0) : rect;
        const hasHeader = region.r0 <= tab.meta.frozenRows || (filter && filter.row === region.r0) || isHeaderRow(wb, activeTabId, region);
        const body = { ...region, r0: hasHeader ? region.r0 + 1 : region.r0 };
        apply(sortOps(model, wb, activeTabId, body, sel.anchor.col, a.desc));
        toast(`Sorted ${rectA1(body)} by ${a1(sel.anchor.col, body.r0).replace(/\d+/, "")} ${a.desc ? "Z→A" : "A→Z"}`, { action: { label: "Undo", onClick: () => c.live.undo() } });
        break;
      }
      case "filter": {
        if (tab.meta.filter) {
          apply(tabPatchOps(model, activeTabId, { filter: null }));
          break;
        }
        const region = rect.r0 === rect.r1 && rect.c0 === rect.c1 ? dataRegion(tab, rect.c0, rect.r0) : rect;
        apply(tabPatchOps(model, activeTabId, { filter: { row: region.r0, c0: region.c0, c1: region.c1, hidden: {} } as any }));
        break;
      }
      case "freeze": {
        // Freeze through the active cell's row (or column); "none" unfreezes both.
        if (a.axis === "none") apply(tabPatchOps(model, activeTabId, { frozen_rows: null, frozen_cols: null }));
        else if (a.axis === "row") apply(tabPatchOps(model, activeTabId, { frozen_rows: sel.anchor.row }));
        else apply(tabPatchOps(model, activeTabId, { frozen_cols: sel.anchor.col }));
        break;
      }
      case "insert": {
        const at = a.axis === "row" ? (a.after ? rect.r1 + 1 : rect.r0) : a.after ? rect.c1 + 1 : rect.c0;
        const n = a.axis === "row" ? rect.r1 - rect.r0 + 1 : rect.c1 - rect.c0 + 1;
        apply(structuralOps(model, activeTabId, a.axis, at, n));
        break;
      }
      case "delete": {
        const at = a.axis === "row" ? rect.r0 : rect.c0;
        const n = a.axis === "row" ? rect.r1 - rect.r0 + 1 : rect.c1 - rect.c0 + 1;
        apply(structuralOps(model, activeTabId, a.axis, at, -n));
        break;
      }
      case "clearFormat":
        apply(styleOps(model, activeTabId, rect, { b: null, i: null, u: null, fs: null, al: null, color: null, fill: null, nf: null, dp: null, sign: null, cur: null, bd: null, wrap: null }));
        break;
    }
}

export function writeSheetClipboard(e: React.ClipboardEvent, cut: boolean, c: SheetCtx) {
  const { S, docId, move, setCopyRect } = c;
    const { model, activeTabId, rect, wb, tab, hiddenRows } = S.current;
    e.preventDefault();
    const rowsList = visibleRowsOf(rect, hiddenRows, tab.rows);
    const c1 = Math.min(rect.c1, Math.max(tab.cols, rect.c0));
    const grid = rowsList.map((r) => {
      const line: string[] = [];
      for (let c = rect.c0; c <= c1; c++) {
        const info = wb.cell(activeTabId, c, r);
        line.push(info ? formatValue(info.value, styleOf(tab.cells.get(cellNum(c, r))), info.implied) : "");
      }
      return line;
    });
    const id = Math.random().toString(36).slice(2, 10);
    const clipRect = { ...rect, c1, r1: rowsList[rowsList.length - 1] ?? rect.r0 };
    const tsv = toTsv(grid);
    e.clipboardData.setData("text/plain", tsv);
    // The system clipboard keeps only text and HTML (Chrome drops custom types), so the HTML carries the copy's id.
    e.clipboardData.setData("text/html", `<table data-codecast-clip="${id}">${grid.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</table>`);
    // Our own payload names the copy, so a paste knows it came from here (and whether it is a move).
    e.clipboardData.setData(CLIP_MIME, JSON.stringify({ id, doc: docId }));
    lastClip = { id, docId: docId, tabId: activeTabId, rect: clipRect, clip: clipOf(model, activeTabId, clipRect, rowsList), cut, text: tsv };
    setCopyRect({ tab: activeTabId, rect: clipRect });
}

export function pasteSheetClipboard(e: React.ClipboardEvent, c: SheetCtx) {
  const { S, pasteValuesRef, docId, move, apply, select, setCopyRect } = c;
    const { model, activeTabId, rect, readOnly } = S.current;
    e.preventDefault();
    if (readOnly) return;
    let mine: { id: string; doc: string } | null = null;
    try {
      mine = JSON.parse(e.clipboardData.getData(CLIP_MIME) || "null");
    } catch {
      mine = null;
    }
    const text = e.clipboardData.getData("text/plain");
    // Our own copy, recognized by its id (custom type, else the HTML), else by being exactly the text we put there.
    const htmlId = e.clipboardData.getData("text/html").match(/data-codecast-clip="([a-z0-9]+)"/)?.[1];
    if (!mine && lastClip && (htmlId === lastClip.id || (text && text === lastClip.text))) mine = { id: lastClip.id, doc: lastClip.docId };
    const valuesOnly = pasteValuesRef.current;
    pasteValuesRef.current = false;
    if (!valuesOnly && mine && lastClip && lastClip.id === mine.id && lastClip.docId === docId) {
      const clip = lastClip;
      const h = clip.clip.cells.length, w = clip.clip.cells[0]?.length ?? 0;
      if (clip.cut) {
        // A cut is a move: references to the cells follow them, on any tab.
        apply(moveOps(model, clip.tabId, clip.rect, rect.c0, rect.r0, activeTabId));
      } else {
        const target = rect.c1 - rect.c0 + 1 >= w && rect.r1 - rect.r0 + 1 >= h ? rect : { c0: rect.c0, r0: rect.r0, c1: rect.c0 + w - 1, r1: rect.r0 + h - 1 };
        apply(pasteClipOps(model, activeTabId, clip.clip, target));
      }
      if (clip.cut) lastClip = null;
      select({ anchor: { col: rect.c0, row: rect.r0 }, focus: { col: rect.c0 + w - 1, row: rect.r0 + h - 1 } }, { reveal: false });
    } else if (text) {
      const grid = parseTsv(text);
      if (grid.length === 1 && grid[0].length === 1 && (rect.c0 !== rect.c1 || rect.r0 !== rect.r1)) {
        const cells: Array<{ col: number; row: number; input: string }> = [];
        for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) cells.push({ col: c, row: r, input: grid[0][0] });
        apply(inputOps(model, activeTabId, cells));
      } else {
        apply(gridOps(model, activeTabId, rect.c0, rect.r0, grid));
        const w = Math.max(...grid.map((r) => r.length));
        select({ anchor: { col: rect.c0, row: rect.r0 }, focus: { col: rect.c0 + w - 1, row: rect.r0 + grid.length - 1 } }, { reveal: false });
      }
    }
    setCopyRect(null);
}

/**
 * What an edit commits: the input (a listed dropdown value takes its listed
 * case), or why not: a formula that doesn't parse, or a strict cell's refusal.
 */
export function checkCommit(model: SheetModel, e: { tab: string; col: number; row: number; text: string }): { input: string } | { error: string } | { refuse: string } {
  const typed = finishInput(e.text);
  if (typed.startsWith("=") && typed.length > 1) {
    try {
      parseFormula(typed.slice(1));
    } catch (x) {
      return { error: x instanceof Error ? x.message : "This formula can't be read" };
    }
  }
  return validateInput(validationAt(model, e.tab, e.col, e.row), typed);
}

/** Column widths as the layout takes them: hidden columns at zero. */
export function layoutWidths(tab: TabData): Map<number, number> {
  if (!tab.hiddenCols?.size) return tab.colWidths;
  const widths = new Map(tab.colWidths);
  for (const c of tab.hiddenCols) widths.set(c, 0);
  return widths;
}

/** Arrow-key movement: a step (over hidden lines and out of merges), or with jump the Ctrl/⌘+arrow edge of the data. */
export function moveSelection(dc: number, dr: number, extend: boolean, jump: boolean, S: MutableRefObject<SheetState>, select: (next: Sel, opts?: { reveal?: boolean }) => void) {
  const { sel, cols, rows, tab } = S.current;
  const from = extend ? sel.focus : sel.anchor;
  let col = from.col, row = from.row;
  // Stepping out of a merged cell starts from its far edge in the direction of travel.
  const inMerge = !extend && mergeAt(S.current.model, S.current.activeTabId, col, row);
  if (inMerge) {
    col = dc > 0 ? inMerge.rect.c1 : dc < 0 ? inMerge.rect.c0 : col;
    row = dr > 0 ? inMerge.rect.r1 : dr < 0 ? inMerge.rect.r0 : row;
  }
  if (jump) {
    // Ctrl/⌘+arrow: to the edge of the current run of data, or the next data.
    const has = (c: number, r: number) => {
      const el = tab.cells.get(cellNum(c, r));
      return !!el && typeof el.input === "string" && el.input !== "";
    };
    const limitC = Math.max(tab.cols, 1), limitR = Math.max(tab.rows, 1);
    const step = () => {
      const nc = col + dc, nr = row + dr;
      if (nc < 1 || nr < 1 || (dc > 0 && nc > limitC) || (dr > 0 && nr > limitR)) return false;
      col = nc;
      row = nr;
      return true;
    };
    const startFilled = has(col, row);
    const nextFilled = has(col + dc, row + dr);
    if (startFilled && nextFilled) {
      while (has(col + dc, row + dr) && step());
    } else {
      while (step() && !has(col, row));
    }
  } else {
    for (let i = 0; i < Math.abs(dc); i++) col = cols.step(col, dc > 0 ? 1 : -1);
    for (let i = 0; i < Math.abs(dr); i++) row = rows.step(row, dr > 0 ? 1 : -1);
  }
  col = Math.max(1, Math.min(cols.count, col));
  row = Math.max(1, Math.min(rows.count, row));
  select(extend ? { anchor: sel.anchor, focus: { col, row } } : { anchor: { col, row }, focus: { col, row } });
}

/** A spilled cell's source formula, for the formula bar ("=UNIQUE(A2:A9)", shown muted). */
export function spillSource(wb: Workbook, tabId: string, at: { col: number; row: number }): string | undefined {
  const a = wb.spillAnchor(tabId, at.col, at.row);
  return a ? wb.cell(tabId, a.col, a.row)?.input : undefined;
}

/** Show the run of hidden columns or rows that ends just before `at` (the header mark's click). */
export function unhideBefore(axis: "col" | "row", at: number, c: SheetCtx) {
  const { model, activeTabId, tab } = c.S.current;
  const hidden = axis === "col" ? tab.hiddenCols : tab.hiddenRows;
  const run: number[] = [];
  for (let i = at - 1; i >= 1 && hidden?.has(i); i--) run.push(i);
  if (run.length) c.apply(hideOps(model, activeTabId, axis, run, false));
}

/** Hide the selected columns or rows; unhiding also shows hidden ones at the selection's edges, so selecting around a gap works. */
export function hideSelection(axis: "col" | "row", hide: boolean, c: SheetCtx) {
  const { model, activeTabId, rect, tab } = c.S.current;
  const lo = axis === "col" ? rect.c0 : rect.r0, hi = axis === "col" ? rect.c1 : rect.r1;
  const indices: number[] = [];
  for (let i = lo; i <= Math.min(hi, lo + 5000); i++) indices.push(i);
  if (!hide) {
    const hidden = axis === "col" ? tab.hiddenCols : tab.hiddenRows;
    for (let i = lo - 1; i >= 1 && hidden?.has(i); i--) indices.push(i);
    for (let i = hi + 1; hidden?.has(i); i++) indices.push(i);
  }
  c.apply(hideOps(model, activeTabId, axis, indices, hide));
}

/** The cell menu's Cut / Copy / Paste: copy and cut run the sheet's own handlers; paste reads the system clipboard. */
export function sheetClipboardCommand(kind: "cut" | "copy" | "paste" | "values", c: SheetCtx) {
  if (kind === "cut" || kind === "copy") {
    c.sinkRef.current?.focus({ preventScroll: true });
    document.execCommand(kind);
    return;
  }
  void (async () => {
    try {
      const items = await navigator.clipboard.read();
      const data = new Map<string, string>();
      for (const item of items) for (const type of item.types) if (type === "text/plain" || type === "text/html") data.set(type, await (await item.getType(type)).text());
      if (kind === "values") c.pasteValuesRef.current = true;
      pasteSheetClipboard({ preventDefault() {}, clipboardData: { getData: (t: string) => data.get(t) ?? "" } } as unknown as React.ClipboardEvent, c);
    } catch {
      // The browser won't hand over the clipboard: paste the sheet's own last copy if there is one, else point at the keys.
      if (lastClip && lastClip.docId === c.docId) {
        if (kind === "values") c.pasteValuesRef.current = true;
        const clip = lastClip;
        const fake = { preventDefault() {}, clipboardData: { getData: (t: string) => (t === CLIP_MIME ? JSON.stringify({ id: clip.id, doc: clip.docId }) : t === "text/plain" ? clip.text : "") } };
        pasteSheetClipboard(fake as unknown as React.ClipboardEvent, c);
      } else toast(createElement(PasteHint));
    }
  })();
}

export type SheetState = {
  model: SheetModel;
  wb: Workbook;
  tab: TabData;
  activeTabId: string;
  sel: Sel;
  rect: Rect;
  cols: AxisLayout;
  rows: AxisLayout;
  frozenRows: number;
  frozenCols: number;
  readOnly: boolean;
  readOnlyDoc: boolean;
  hiddenRows: Set<number>;
};

type Cell = { col: number; row: number };

/** What the sheet's event handlers read and call, refreshed on every render of SheetView. */
export type SheetCtx = {
  S: MutableRefObject<SheetState>;
  edit: EditStore;
  pointRef: MutableRefObject<{ start: number; end: number; anchor: Cell; focus: Cell } | null>;
  caretRef: MutableRefObject<number>;
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  sinkRef: MutableRefObject<HTMLTextAreaElement | null>;
  pasteValuesRef: MutableRefObject<boolean>;
  dragRef: MutableRefObject<{ kind: "cells" | "cols" | "rows" | "fill"; origin: Rect } | null>;
  live: LiveHandle;
  docId: string;
  cancelEdit: () => void;
  commitEdit: (dc?: number, dr?: number) => void;
  commitToSelection: () => void;
  move: (dc: number, dr: number, extend?: boolean, jump?: boolean) => void;
  beginEdit: (text: string | null, mode: "enter" | "edit", surface?: "cell" | "bar") => void;
  apply: (ops: ArtifactOp[]) => void;
  onFormat: (a: FormatAction) => void;
  select: (next: Sel, opts?: { reveal?: boolean }) => void;
  setSel: Dispatch<SetStateAction<Sel>>;
  setCopyRect: (v: { tab: string; rect: Rect } | null) => void;
  setFillPreview: (v: Rect | null) => void;
  setFindOpen: (v: boolean) => void;
  /** Open the dropdown or date picker of a validated cell (the active one by default); false when it has none. */
  openPicker: (col?: number, row?: number, query?: string) => boolean;
  /** Where a run of Tab entries started, so Enter goes back to that column on the next row (null outside a run). */
  tabRunRef: MutableRefObject<number | null>;
  /** Comment on the active cell (its open thread, or a new one). */
  openCellComment: () => void;
  /** Open the conditional color rules panel. */
  openRules: () => void;
};
