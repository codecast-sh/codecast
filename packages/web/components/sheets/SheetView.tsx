// A live sheet: tabs of cells that people and agent sessions edit together.
// Reads come from the doc's elements (useLiveElements), folded into a model
// and a recalculating Workbook held across renders and synced by diff, so an
// edit re-evaluates only what depends on it. Writes are element ops from
// @codecast/shared/artifacts/sheets through live.apply. Other participants'
// selections and an agent's write range are outlined in their color.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Check, Filter as FilterIcon, RefreshCw, Radio, X } from "lucide-react";
import type { ArtifactPresence } from "@codecast/shared/artifacts";
import {
  Workbook,
  a1,
  addTabOps,
  borderOps,
  LiveSheet,
  cellNum,
  clearOps,
  clipOf,
  deleteTabOps,
  fillOps,
  formatValue,
  gridOps,
  inputOps,
  moveOps,
  isFormula,
  newElementKey,
  normRect,
  parseQualifiedRange,
  parseTsv,
  pasteClipOps,
  quoteTabName,
  rectA1,
  renameTabOps,
  sortOps,
  structuralOps,
  styleOf,
  styleOps,
  tabPatchOps,
  tokenize,
  toTsv,
  colWidthOps,
  rowHeightOps,
  fitWidthOps,
  inheritedFormat,
  refText,
  shiftFormula,
  uniqueTabName,
  type CellStyle,
  type PaletteColor,
  type Rect,
  type SheetClip,
  type SheetModel,
  type TabData,
  type QuerySource,
} from "./sheetCore";
import type { LiveViewProps } from "../live/registry";
import { useLiveElements, useLivePresence } from "../live/useLiveArtifact";
import { sendAsk, pickAskTarget, reopenAsk } from "../live/AskAgentControl";
import { ContextMenu, CursorPopover, CtxItem, useContextMenu } from "../ui/context-menu";
import { DropdownMenuSeparator } from "../ui/dropdown-menu";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { createEditStore, finishInput, wantsReference, type EditStore } from "./editStore";
import { AxisLayout } from "./layout";
import { SheetGrid, ROW_HEADER_W, COL_HEADER_H, BOTTOM_ROOM, cellViewportRect, hitTest, type GridHit, type Outline } from "./SheetGrid";
import { CellEditor, FormulaBar, SelectionSummary, TabStrip, type EditorPlacement } from "./SheetChrome";
import { FormatBar, SHEET_ASK_SLOT, type FormatAction } from "./FormatBar";
import { useQueryTabRefresh } from "./useQueryTabRefresh";
import { solVar } from "./cellPaint";
import "./sheet.css";

const DEF_COL_W = 104;
const DEF_ROW_H = 26;
const REF_COLORS: PaletteColor[] = ["blue", "magenta", "green", "orange", "violet", "cyan", "red", "yellow"];

type Sel = { anchor: { col: number; row: number }; focus: { col: number; row: number } };
type Menu = { kind: "cell" | "colHeader" | "rowHeader"; col: number; row: number } | { kind: "tab"; tabId: string };

/** Internal clipboard: cell fields with their origin, so a paste here shifts formulas. */
let lastClip: { id: string; docId: string; tabId: string; rect: Rect; clip: SheetClip; cut: boolean } | null = null;
const CLIP_MIME = "application/x-codecast-sheet";

function selRect(s: Sel): Rect {
  return normRect({ c0: s.anchor.col, r0: s.anchor.row, c1: s.focus.col, r1: s.focus.row });
}

function parsePosition(pos: string | undefined): { tab: string; rect: Rect } | null {
  if (!pos) return null;
  const bang = pos.lastIndexOf("!");
  if (bang < 0) return null;
  const q = parseQualifiedRange(`x!${pos.slice(bang + 1)}`);
  return q ? { tab: pos.slice(0, bang), rect: q.rect } : null;
}

export default function SheetView({ doc, live, setSelection, mode, snapshot, setToolbar }: LiveViewProps) {
  const params = useSearchParams();
  const liveEls = useLiveElements(doc._id);
  const elements = snapshot ?? liveEls;
  const readOnlyDoc = mode === "view";

  // ── Model and workbook (held across renders, synced by diff) ──────────────
  const held = useRef<LiveSheet | null>(null);
  if (!held.current) held.current = new LiveSheet();
  // TODAY()/NOW() recalculate as the minute turns.
  const minute = useCoarseNow(60_000);
  const { model, wb, version } = useMemo(() => {
    const h = held.current!;
    h.update(elements);
    h.refreshClock();
    return { model: h.model, wb: h.wb, version: h.version };
  }, [elements, minute]);

  const [tabId, setTabId] = useState<string>(() => {
    const want = params.get("tab");
    return (want && model.tabs.find((t) => t.id === want || t.name === want)?.id) || model.tabs[0].id;
  });
  // ?tab=<name> is the tab's address: honored once the tabs load, and kept in step on switch.
  const router = useRouter();
  const wantTab = params.get("tab");
  useEffect(() => {
    if (!wantTab) return;
    const t = model.tabs.find((x) => x.id === wantTab || x.name.toLowerCase() === wantTab.toLowerCase());
    if (t) setTabId(t.id);
  }, [wantTab, model.tabs]);
  const showTab = useCallback((id: string) => {
    setTabId(id);
    const name = held.current?.model.byId.get(id)?.meta.name ?? id;
    const next = new URLSearchParams(window.location.search);
    next.set("tab", name);
    next.delete("el");
    router.replace(`${window.location.pathname}?${next.toString()}`, { scroll: false });
  }, [router]);
  const showTabRef = useRef(showTab);
  showTabRef.current = showTab;
  const tab: TabData = model.byId.get(tabId) ?? model.byId.get(model.tabs[0].id)!;
  const activeTabId = tab.meta.id;
  const queryTab = !!tab.meta.query;
  // A live query tab locks its contents (the server fills them); layout and formats stay editable.
  // Until the first answer arrives an empty grid is not the sheet: hold edits.
  const loading = !live.ready && !snapshot && elements.length === 0;
  const readOnly = readOnlyDoc || queryTab || loading;

  // ── Filter: hidden rows ───────────────────────────────────────────────────
  const filter = tab.meta.filter;
  const hiddenRows = useMemo(() => {
    const hidden = new Set<number>();
    if (!filter) return hidden;
    const entries = Object.entries(filter.hidden ?? {}).filter(([, vals]) => vals.length);
    if (!entries.length) return hidden;
    for (let r = filter.row + 1; r <= tab.rows; r++) {
      for (const [c, vals] of entries) {
        const col = Number(c);
        const info = wb.cell(activeTabId, col, r);
        const text = info ? formatValue(info.value, styleOf(tab.cells.get(cellNum(col, r))), info.implied) : "";
        if (vals.includes(text)) {
          hidden.add(r);
          break;
        }
      }
    }
    return hidden;
  }, [filter, tab, wb, version, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Layout ────────────────────────────────────────────────────────────────
  const cols = useMemo(() => new AxisLayout(Math.min(18_278, Math.max(26, tab.cols + 8)), DEF_COL_W, tab.colWidths), [tab.cols, tab.colWidths]);
  const rows = useMemo(() => {
    const custom = new Map(tab.rowHeights);
    // Wrapped text grows its row (unless someone set the height), so wrapping never hides text.
    for (const [n, el] of tab.cells) {
      if (!el.wrap || typeof el.input !== "string") continue;
      const row = Math.floor(n / 32768), col = n % 32768;
      if (tab.rowHeights.has(row)) continue;
      const w = (tab.colWidths.get(col) ?? DEF_COL_W) - 14;
      const lines = Math.ceil((String(wb.value(activeTabId, col, row) ?? "").length * 7.6) / Math.max(20, w));
      const h = Math.max(DEF_ROW_H, lines * 18 + 8);
      if (h > (custom.get(row) ?? DEF_ROW_H)) custom.set(row, h);
    }
    for (const r of hiddenRows) custom.set(r, 0);
    return new AxisLayout(Math.max(1000, tab.rows + 200), DEF_ROW_H, custom);
  }, [tab, hiddenRows, wb, version, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps
  const frozenRows = tab.meta.frozenRows, frozenCols = tab.meta.frozenCols;

  // ── Selection ─────────────────────────────────────────────────────────────
  const [sel, setSel] = useState<Sel>({ anchor: { col: 1, row: 1 }, focus: { col: 1, row: 1 } });
  const rect = selRect(sel);
  const active = sel.anchor;
  const edit = useRef<EditStore>(createEditStore()).current;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sinkRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef(0);
  /** The reference arrow keys are walking into a formula: where it sits in the text, and its cells. */
  const pasteValuesRef = useRef(false);
  const pointRef = useRef<{ start: number; end: number; anchor: { col: number; row: number }; focus: { col: number; row: number } } | null>(null);
  const tabMemory = useRef(new Map<string, { sel: Sel; left: number; top: number }>());
  const [copyRect, setCopyRect] = useState<{ tab: string; rect: Rect } | null>(null);
  const [fillPreview, setFillPreview] = useState<Rect | null>(null);
  const [scrollTick, setScrollTick] = useState(0);

  // Everything handlers need, read live so they stay stable.
  const S = useRef({ model, wb, tab, activeTabId, sel, rect, cols, rows, frozenRows, frozenCols, readOnly, readOnlyDoc, hiddenRows });
  S.current = { model, wb, tab, activeTabId, sel, rect, cols, rows, frozenRows, frozenCols, readOnly, readOnlyDoc, hiddenRows };

  const apply = useCallback((ops: Parameters<typeof live.apply>[0]) => {
    if (ops.length) live.apply(ops);
  }, [live]);

  // Selection -> presence (my range, in this tab) and the shell's Ask selection.
  useEffect(() => {
    const keys: string[] = [];
    for (let r = rect.r0; r <= Math.min(rect.r1, rect.r0 + 39); r++)
      for (let c = rect.c0; c <= Math.min(rect.c1, rect.c0 + 25); c++) {
        const el = tab.cells.get(cellNum(c, r));
        if (el) keys.push(el.key);
      }
    const text = rectA1(rect);
    if (!readOnlyDoc) {
      setSelection(keys.slice(0, 40));
      live.setPresence({ position: text.includes(":") ? { range: `${activeTabId}!${text}` } : { cell: `${activeTabId}!${text}` }, selection: keys.slice(0, 40) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presence follows the selection, not every cell write
  }, [rect.c0, rect.r0, rect.c1, rect.r1, activeTabId]);

  // Deep link ?el=c:<tab>!B2 selects that cell.
  useEffect(() => {
    const el = params.get("el");
    const m = el?.match(/^c:([^!]+)!([A-Z]+)(\d+)$/);
    if (!m) return;
    const q = parseQualifiedRange(`x!${m[2]}${m[3]}`);
    if (!q) return;
    if (model.byId.has(m[1])) setTabId(m[1]);
    setSel({ anchor: { col: q.rect.c0, row: q.rect.r0 }, focus: { col: q.rect.c0, row: q.rect.r0 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // ── Scrolling the active cell into view ───────────────────────────────────
  const reveal = useCallback((col: number, row: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const { cols, rows, frozenCols, frozenRows } = S.current;
    const frozenW = cols.offset(frozenCols + 1), frozenH = rows.offset(frozenRows + 1);
    if (col > frozenCols) {
      const x0 = cols.offset(col) - frozenW, x1 = cols.offset(col + 1) - frozenW;
      const view = el.clientWidth - ROW_HEADER_W - frozenW;
      if (x0 < el.scrollLeft) el.scrollLeft = x0;
      else if (x1 > el.scrollLeft + view) el.scrollLeft = x1 - view + 2;
    }
    if (row > frozenRows) {
      const y0 = rows.offset(row) - frozenH, y1 = rows.offset(row + 1) - frozenH;
      const view = el.clientHeight - COL_HEADER_H - frozenH - BOTTOM_ROOM;
      if (y0 < el.scrollTop) el.scrollTop = y0;
      else if (y1 > el.scrollTop + view) el.scrollTop = y1 - view + 2;
    }
  }, []);

  const select = useCallback((next: Sel, opts: { reveal?: boolean } = {}) => {
    setSel(next);
    if (opts.reveal !== false) requestAnimationFrame(() => reveal(next.focus.col, next.focus.row));
  }, [reveal]);

  // ── Editing ───────────────────────────────────────────────────────────────
  const beginEdit = useCallback((text: string | null, mode: "enter" | "edit", surface: "cell" | "bar" = "cell") => {
    const { readOnly, wb, activeTabId, sel } = S.current;
    if (readOnly) {
      if (queryTabRef.current) toast("This tab is a live query; it fills itself.");
      return;
    }
    const cur = wb.cell(activeTabId, sel.anchor.col, sel.anchor.row)?.input ?? "";
    edit.set({ tab: activeTabId, col: sel.anchor.col, row: sel.anchor.row, text: text ?? cur, mode, surface });
    caretRef.current = (text ?? cur).length;
  }, [edit]);
  const queryTabRef = useRef(queryTab);
  queryTabRef.current = queryTab;

  const move = useCallback((dc: number, dr: number, extend = false, jump = false) => {
    const { sel, cols, rows, tab } = S.current;
    const from = extend ? sel.focus : sel.anchor;
    let col = from.col, row = from.row;
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
  }, [select]);

  const commitEdit = useCallback((dc = 0, dr = 0) => {
    const e = edit.get();
    if (!e) return;
    edit.set(null);
    const { model, activeTabId } = S.current;
    const input = finishInput(e.text);
    apply(inputOps(model, e.tab, [{ col: e.col, row: e.row, input }]));
    if (e.tab !== activeTabId) showTabRef.current?.(e.tab);
    sinkRef.current?.focus({ preventScroll: true });
    if ((dc || dr) && e.tab === activeTabId) move(dc, dr);
  }, [edit, apply, move]);

  const commitToSelection = useCallback(() => {
    const e = edit.get();
    if (!e) return;
    edit.set(null);
    const { model, activeTabId, rect } = S.current;
    if (e.tab !== activeTabId) {
      edit.set(e);
      commitEdit();
      return;
    }
    const input = finishInput(e.text);
    const cells: Array<{ col: number; row: number; input: string }> = [];
    for (let r = rect.r0; r <= rect.r1; r++)
      for (let c = rect.c0; c <= rect.c1; c++) {
        // Formulas shift relative to the active cell, like a fill.
        cells.push({ col: c, row: r, input: isFormula(input) ? shiftFormulaSafe(input, c - e.col, r - e.row) : input });
      }
    apply(inputOps(model, activeTabId, cells));
    sinkRef.current?.focus({ preventScroll: true });
  }, [edit, apply, commitEdit]);

  const cancelEdit = useCallback(() => {
    edit.set(null);
    sinkRef.current?.focus({ preventScroll: true });
  }, [edit]);

  // ── Formatting actions ────────────────────────────────────────────────────
  const activeEl = tab.cells.get(cellNum(active.col, active.row));
  const activeStyle: CellStyle = styleOf(activeEl);

  const onFormat = useCallback((a: FormatAction) => {
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
        const range = rectA1(rect);
        const existing = model.conds.filter((c) => c.tab === activeTabId && rectA1(c.rect) === range);
        if (a.rule === "clear") {
          const hits = model.conds.filter((c) => c.tab === activeTabId && c.rect.c0 <= rect.c1 && c.rect.c1 >= rect.c0 && c.rect.r0 <= rect.r1 && c.rect.r1 >= rect.r0);
          apply(hits.map((c) => ({ k: c.key, del: true as const })));
        } else {
          apply([{ k: existing[0]?.key ?? newElementKey("cf"), put: { kind: "cf", tab: activeTabId, range, rule: a.rule, ...(a.color ? { color: a.color } : {}) } }]);
        }
        break;
      }
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
        toast(`Sorted ${rectA1(body)} by ${a1(sel.anchor.col, body.r0).replace(/\d+/, "")} ${a.desc ? "Z→A" : "A→Z"}`);
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
  }, [apply, filter]);

  // ── Clipboard ─────────────────────────────────────────────────────────────
  const visibleRows = visibleRowsOf;

  const writeClipboard = useCallback((e: React.ClipboardEvent, cut: boolean) => {
    const { model, activeTabId, rect, wb, tab, hiddenRows } = S.current;
    e.preventDefault();
    const rowsList = visibleRows(rect, hiddenRows, tab.rows);
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
    e.clipboardData.setData("text/plain", toTsv(grid));
    e.clipboardData.setData("text/html", `<table>${grid.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</table>`);
    // Our own payload names the copy, so a paste knows it came from here (and whether it is a move).
    e.clipboardData.setData(CLIP_MIME, JSON.stringify({ id, doc: doc._id }));
    lastClip = { id, docId: doc._id, tabId: activeTabId, rect: clipRect, clip: clipOf(model, activeTabId, clipRect, rowsList), cut };
    setCopyRect({ tab: activeTabId, rect: clipRect });
  }, [doc._id]);

  const copySelection = useCallback((e: React.ClipboardEvent) => writeClipboard(e, false), [writeClipboard]);
  const cutSelection = useCallback((e: React.ClipboardEvent) => {
    if (S.current.readOnly) return copySelection(e);
    const { rect: r, hiddenRows: hid } = S.current;
    for (let row = r.r0; row <= r.r1; row++)
      if (hid.has(row)) {
        // Moving a range with rows the filter hides would move cells nobody can see.
        copySelection(e);
        toast("Copied instead: the range has rows a filter hides. Clear the filter to move it.");
        return;
      }
    writeClipboard(e, true);
  }, [writeClipboard, copySelection]);

  const pasteInto = useCallback((e: React.ClipboardEvent) => {
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
    const valuesOnly = pasteValuesRef.current;
    pasteValuesRef.current = false;
    if (!valuesOnly && mine && lastClip && lastClip.id === mine.id && lastClip.docId === doc._id) {
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
  }, [apply, select, doc._id]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const onKey = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, surface: "cell" | "bar") => {
    const mod = e.metaKey || e.ctrlKey;
    const st = edit.get();
    if (st) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === "Enter" && !e.altKey) {
        e.preventDefault();
        if (mod) commitToSelection();
        else commitEdit(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitEdit(e.shiftKey ? -1 : 1, 0);
      } else if (e.key === "F4") {
        // Cycle the reference at the caret through A1, $A$1, A$1, $A1.
        e.preventDefault();
        const el = e.currentTarget;
        const next = cycleAnchors(st.text, el.selectionStart ?? st.text.length);
        if (next) {
          edit.patch({ text: next.text });
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = next.caret; });
        }
      } else if (st.mode === "enter" && e.key.startsWith("Arrow")) {
        const el = e.currentTarget;
        // While pointing, the caret is where the last step left it (key repeat can outrun a render).
        const caret = pointRef.current ? caretRef.current : (el.selectionStart ?? 0);
        const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
        const pt = pointRef.current;
        if ((pt && caret === pt.end) || wantsReference(st.text, caret)) {
          // Pointing: arrows walk a reference into the formula, shift widens it to a range.
          e.preventDefault();
          const base = pt && caret === pt.end ? pt : { start: caret, end: caret, anchor: { col: st.col, row: st.row }, focus: { col: st.col, row: st.row } };
          const focus = { col: Math.max(1, base.focus.col + d[0]), row: Math.max(1, base.focus.row + d[1]) };
          const anchor = e.shiftKey ? base.anchor : focus;
          const ref = rectA1(normRect({ c0: anchor.col, r0: anchor.row, c1: focus.col, r1: focus.row }));
          const text = st.text.slice(0, base.start) + ref + st.text.slice(base.end);
          pointRef.current = { start: base.start, end: base.start + ref.length, anchor, focus };
          edit.patch({ text });
          caretRef.current = base.start + ref.length;
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = base.start + ref.length; });
          return;
        }
        e.preventDefault();
        commitEdit(d[0], d[1]);
      }
      if (!e.key.startsWith("Arrow") && e.key !== "Shift") pointRef.current = null;
      return;
    }
    if (surface !== "cell") return;
    const { readOnly, model, activeTabId, rect } = S.current;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
        move(d[0], d[1], e.shiftKey, mod);
        return;
      }
      case "Tab":
        e.preventDefault();
        move(e.shiftKey ? -1 : 1, 0);
        return;
      case "Enter":
        e.preventDefault();
        if (e.shiftKey) move(0, -1);
        else beginEdit(null, "edit");
        return;
      case "F2":
        e.preventDefault();
        beginEdit(null, "edit");
        return;
      case "Escape":
        setCopyRect(null);
        return;
      case "End":
        e.preventDefault();
        if (mod) {
          const t = S.current.tab;
          select({ anchor: { col: Math.max(1, t.cols), row: Math.max(1, t.rows) }, focus: { col: Math.max(1, t.cols), row: Math.max(1, t.rows) } });
        } else move(1, 0, e.shiftKey, true);
        return;
      case "Home":
        e.preventDefault();
        select({ anchor: { col: 1, row: mod ? 1 : S.current.sel.anchor.row }, focus: { col: 1, row: mod ? 1 : S.current.sel.anchor.row } });
        return;
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        // A page is the visible height, whatever the row heights.
        const el = scrollerRef.current;
        const { rows: ly, sel: cur } = S.current;
        const view = el ? el.clientHeight - COL_HEADER_H - BOTTOM_ROOM : 400;
        const from = e.shiftKey ? cur.focus.row : cur.anchor.row;
        const target = e.key === "PageDown" ? ly.indexAt(ly.offset(from) + view) : ly.indexAt(Math.max(0, ly.offset(from) - view));
        move(0, target - from, e.shiftKey);
        return;
      }
      case "Backspace":
      case "Delete":
        e.preventDefault();
        if (!readOnly) apply(clearVisible(model, activeTabId, rect, S.current.hiddenRows));
        return;
    }
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "v" && e.shiftKey) {
        // The paste event that follows takes values only.
        pasteValuesRef.current = true;
        return;
      }
      if (k === " " || e.code === "Space") {
        e.preventDefault();
        select({ anchor: { col: rect.c0, row: 1 }, focus: { col: rect.c1, row: S.current.rows.count } }, { reveal: false });
        return;
      }
      if (k === ";" && !readOnly) {
        e.preventDefault();
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        apply(inputOps(model, activeTabId, [{ col: S.current.sel.anchor.col, row: S.current.sel.anchor.row, input: today }]));
        return;
      }
      if (k === "f") {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) live.redo();
        else live.undo();
      } else if (k === "y") {
        e.preventDefault();
        live.redo();
      } else if (k === "b" || k === "i" || k === "u") {
        e.preventDefault();
        onFormat({ type: "toggle", field: k as "b" });
      } else if (k === "a") {
        e.preventDefault();
        const t = S.current.tab;
        select({ anchor: { col: 1, row: 1 }, focus: { col: Math.max(1, t.cols), row: Math.max(1, t.rows) } }, { reveal: false });
      } else if (k === "d" && !readOnly) {
        // Fill down from the selection's top row.
        e.preventDefault();
        if (rect.r1 > rect.r0) apply(fillOps(model, activeTabId, { ...rect, r1: rect.r0 }, rect));
      } else if (k === "r" && !readOnly && !e.shiftKey) {
        e.preventDefault();
        if (rect.c1 > rect.c0) apply(fillOps(model, activeTabId, { ...rect, c1: rect.c0 }, rect));
      }
      return;
    }
    if (e.key === " " && e.shiftKey) {
      e.preventDefault();
      select({ anchor: { col: 1, row: rect.r0 }, focus: { col: 18_278, row: rect.r1 } }, { reveal: false });
    }
  }, [edit, cancelEdit, commitEdit, commitToSelection, move, beginEdit, apply, live, onFormat, select]);

  // ── Pointer: select, drag-select, point mode, resize, fill ────────────────
  const dragRef = useRef<{ kind: "cells" | "cols" | "rows" | "fill"; origin: Rect } | null>(null);

  const onPointerDown = useCallback((hit: GridHit, e: React.PointerEvent) => {
    const { sel, cols, rows, frozenCols, frozenRows } = S.current;
    const st = edit.get();
    const el = scrollerRef.current!;
    // Point mode: clicking a cell while typing a formula inserts its reference.
    if (st && hit.zone === "cell" && wantsReference(st.text, caretRef.current)) {
      e.preventDefault();
      const { activeTabId: here, tab: hereTab } = S.current;
      const ref = (st.tab !== here ? `${quoteTabName(hereTab.meta.name)}!` : "") + a1(hit.col, hit.row);
      const caret = caretRef.current;
      const next = st.text.slice(0, caret) + ref + st.text.slice(caret);
      edit.patch({ text: next, mode: "edit" });
      caretRef.current = caret + ref.length;
      requestAnimationFrame(() => {
        const t = st.surface === "bar" ? (document.querySelector("[data-sheet-formula-input]") as HTMLInputElement | null) : sinkRef.current;
        if (t) {
          t.focus();
          t.selectionStart = t.selectionEnd = caret + ref.length;
        }
      });
      return;
    }
    if (st) commitEdit();
    e.preventDefault();
    sinkRef.current?.focus({ preventScroll: true });
    if (hit.zone === "cell" && !e.shiftKey && !S.current.readOnly) {
      // A click on a checkbox cell ticks it.
      const ce = S.current.tab.cells.get(cellNum(hit.col, hit.row));
      if (ce?.nf === "check") {
        const on = S.current.wb.value(S.current.activeTabId, hit.col, hit.row);
        const isOn = on === true || on === 1;
        if (!(typeof ce.input === "string" && isFormula(ce.input))) apply(inputOps(S.current.model, S.current.activeTabId, [{ col: hit.col, row: hit.row, input: isOn ? "FALSE" : "TRUE" }]));
      }
    }
    if (hit.zone === "cell") {
      const next: Sel = e.shiftKey ? { anchor: sel.anchor, focus: { col: hit.col, row: hit.row } } : { anchor: { col: hit.col, row: hit.row }, focus: { col: hit.col, row: hit.row } };
      select(next, { reveal: false });
      dragRef.current = { kind: "cells", origin: selRect(next) };
    } else if (hit.zone === "colHeader") {
      const anchorCol = e.shiftKey ? sel.anchor.col : hit.col;
      select({ anchor: { col: anchorCol, row: 1 }, focus: { col: hit.col, row: rows.count } }, { reveal: false });
      dragRef.current = { kind: "cols", origin: { c0: anchorCol, c1: anchorCol, r0: 1, r1: rows.count } };
    } else if (hit.zone === "rowHeader") {
      const anchorRow = e.shiftKey ? sel.anchor.row : hit.row;
      select({ anchor: { col: 1, row: anchorRow }, focus: { col: cols.count, row: hit.row } }, { reveal: false });
      dragRef.current = { kind: "rows", origin: { c0: 1, c1: 1, r0: anchorRow, r1: anchorRow } };
    } else {
      select({ anchor: { col: 1, row: 1 }, focus: { col: cols.count, row: rows.count } }, { reveal: false });
      return;
    }
    const frozenW = cols.offset(frozenCols + 1), frozenH = rows.offset(frozenRows + 1);
    let lastX = e.clientX, lastY = e.clientY;
    let raf = 0;
    const update = () => {
      const d = dragRef.current;
      if (!d) return;
      const h = hitTest(el, cols, rows, frozenW, frozenH, lastX, lastY);
      const col = h.zone === "cell" || h.zone === "colHeader" ? h.col : d.origin.c0;
      const row = h.zone === "cell" || h.zone === "rowHeader" ? h.row : d.origin.r0;
      setSel((s) => {
        if (d.kind === "cols") return { anchor: s.anchor, focus: { col, row: rows.count } };
        if (d.kind === "rows") return { anchor: s.anchor, focus: { col: cols.count, row } };
        if (s.focus.col === col && s.focus.row === row) return s;
        return { anchor: s.anchor, focus: { col, row } };
      });
    };
    const autoscroll = () => {
      const r = el.getBoundingClientRect();
      const edge = 28;
      let dx = 0, dy = 0;
      if (lastX > r.right - edge) dx = 18;
      else if (lastX < r.left + ROW_HEADER_W + frozenW && el.scrollLeft > 0) dx = -18;
      if (lastY > r.bottom - edge) dy = 18;
      else if (lastY < r.top + COL_HEADER_H + frozenH && el.scrollTop > 0) dy = -18;
      if (dx || dy) {
        el.scrollLeft += dx;
        el.scrollTop += dy;
        update();
      }
      raf = requestAnimationFrame(autoscroll);
    };
    raf = requestAnimationFrame(autoscroll);
    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      update();
    };
    const onUp = () => {
      dragRef.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [edit, commitEdit, select, apply]);

  const onDoubleClick = useCallback((hit: GridHit) => {
    if (hit.zone !== "cell") return;
    const v = S.current.wb.value(S.current.activeTabId, hit.col, hit.row);
    // A live-query row names a codecast object: double-click opens it.
    if (queryTabRef.current && typeof v === "string" && /^(ct|pl)-\d+$/.test(v)) {
      router.push(v.startsWith("pl-") ? `/plans/${v}` : `/tasks/${v}`);
      return;
    }
    beginEdit(null, "edit");
  }, [beginEdit, router]);

  const onResizeStart = useCallback((axis: "col" | "row", index: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (S.current.readOnlyDoc) return;
    const { cols, rows, activeTabId, rect } = S.current;
    const layout = axis === "col" ? cols : rows;
    const start = axis === "col" ? e.clientX : e.clientY;
    const base = layout.sizeOf(index);
    // Resizing a header inside a whole-column selection resizes every selected column.
    const group =
      axis === "col" && rect.r0 === 1 && rect.r1 >= rows.count && index >= rect.c0 && index <= rect.c1
        ? Array.from({ length: rect.c1 - rect.c0 + 1 }, (_, i) => rect.c0 + i)
        : axis === "row" && rect.c0 === 1 && rect.c1 >= cols.count && index >= rect.r0 && index <= rect.r1
          ? Array.from({ length: rect.r1 - rect.r0 + 1 }, (_, i) => rect.r0 + i)
          : [index];
    const sizeFor = (ev: PointerEvent) => Math.max(axis === "col" ? 32 : 18, Math.min(axis === "col" ? 800 : 400, base + ((axis === "col" ? ev.clientX : ev.clientY) - start)));
    const onMove = (ev: PointerEvent) => {
      const size = sizeFor(ev);
      live.preview(axis === "col" ? colWidthOps(activeTabId, group, size) : rowHeightOps(activeTabId, group, size));
    };
    const onUp = () => {
      live.commit();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [live]);

  const onAutoFit = useCallback((col: number) => {
    if (S.current.readOnlyDoc) return;
    const { model, wb, activeTabId } = S.current;
    apply(fitWidthOps(model, wb, activeTabId, [col]));
  }, [apply]);

  const onFillStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (S.current.readOnly) return;
    const el = scrollerRef.current!;
    const { cols, rows, frozenCols, frozenRows, rect: src } = S.current;
    const frozenW = cols.offset(frozenCols + 1), frozenH = rows.offset(frozenRows + 1);
    let dest = src;
    const onMove = (ev: PointerEvent) => {
      const h = hitTest(el, cols, rows, frozenW, frozenH, ev.clientX, ev.clientY);
      if (h.zone !== "cell") return;
      const down = h.row - src.r1, up = src.r0 - h.row, right = h.col - src.c1, left = src.c0 - h.col;
      const vertical = Math.max(down, up) >= Math.max(right, left);
      if (vertical) dest = down > 0 ? { ...src, r1: h.row } : up > 0 ? { ...src, r0: h.row } : src;
      else dest = right > 0 ? { ...src, c1: h.col } : left > 0 ? { ...src, c0: h.col } : src;
      setFillPreview(dest === src ? null : dest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setFillPreview(null);
      if (dest === src) return;
      const { model, activeTabId } = S.current;
      apply(fillOps(model, activeTabId, src, dest));
      select({ anchor: { col: dest.c0, row: dest.r0 }, focus: { col: dest.c1, row: dest.r1 } }, { reveal: false });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [apply, select]);

  // ── Context menus and filter popover ──────────────────────────────────────
  const menu = useContextMenu<Menu>();
  const filterPop = useContextMenu<{ col: number }>();
  const onContextMenu = useCallback((hit: GridHit, e: React.MouseEvent) => {
    if (hit.zone === "corner") return;
    const { rect } = S.current;
    const { cols: cl, rows: rl } = S.current;
    if (hit.zone === "cell" && !(hit.col >= rect.c0 && hit.col <= rect.c1 && hit.row >= rect.r0 && hit.row <= rect.r1)) {
      select({ anchor: { col: hit.col, row: hit.row }, focus: { col: hit.col, row: hit.row } }, { reveal: false });
    } else if (hit.zone === "colHeader" && !(hit.col >= rect.c0 && hit.col <= rect.c1 && rect.r0 === 1 && rect.r1 >= rl.count)) {
      select({ anchor: { col: hit.col, row: 1 }, focus: { col: hit.col, row: rl.count } }, { reveal: false });
    } else if (hit.zone === "rowHeader" && !(hit.row >= rect.r0 && hit.row <= rect.r1 && rect.c0 === 1 && rect.c1 >= cl.count)) {
      select({ anchor: { col: 1, row: hit.row }, focus: { col: cl.count, row: hit.row } }, { reveal: false });
    }
    menu.open(e, { kind: hit.zone, col: "col" in hit ? hit.col : rect.c0, row: "row" in hit ? hit.row : rect.r0 } as Menu, { force: true });
  }, [menu, select]);

  const onFilterClick = useCallback((col: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    filterPop.open(e, { col }, { force: true });
  }, [filterPop]);

  // ── Agent writes flash briefly, so a person watching sees the sheet fill ──
  const [flash, setFlash] = useState<Set<string> | undefined>(undefined);
  const seenRevs = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const prev = seenRevs.current;
    const next = new Map<string, number>();
    const hits = new Set<string>();
    for (const [n, el] of tab.cells) {
      next.set(el.key, el.rev);
      const before = prev?.get(el.key);
      if (prev && (before === undefined || before < el.rev) && typeof el.by === "string" && el.by.startsWith("s:")) hits.add(`${n % 32768}:${Math.floor(n / 32768)}`);
    }
    seenRevs.current = next;
    if (!hits.size) return;
    setFlash(hits);
    const t = setTimeout(() => setFlash(undefined), 1400);
    return () => clearTimeout(t);
  }, [tab]);
  useEffect(() => { seenRevs.current = null; }, [activeTabId]);

  // ── Others: outlines in their color ───────────────────────────────────────
  const others = useLivePresence(doc._id);
  const editRefsKey = useSyncExternalStore(edit.subscribe, () => refsKeyOf(edit.get()?.text), () => "");
  const outlines: Outline[] = useMemo(() => {
    const out: Outline[] = [];
    for (const p of others as ArtifactPresence[]) {
      const pos = parsePosition(p.position?.range ?? p.position?.cell);
      if (!pos || pos.tab !== activeTabId) continue;
      out.push({ key: p.actor, rect: pos.rect, color: p.color, presence: p, fill: p.kind === "agent" });
    }
    if (copyRect && copyRect.tab === activeTabId) out.push({ key: "copy", rect: copyRect.rect, color: "var(--sol-blue)", dashed: true });
    if (fillPreview) out.push({ key: "fill", rect: fillPreview, color: "var(--sol-text-muted)", dashed: true });
    if (editRefsKey) {
      editRefsKey.split(";").forEach((part, i) => {
        const [tabName, r] = part.split("|");
        if (tabName && model.tabs.find((t) => t.name.toLowerCase() === tabName.toLowerCase())?.id !== activeTabId) return;
        const q = parseQualifiedRange(`x!${r}`);
        if (q) out.push({ key: `ref${i}`, rect: q.rect, color: solVar(REF_COLORS[i % REF_COLORS.length]), fill: true });
      });
    }
    return out;
  }, [others, activeTabId, copyRect, fillPreview, editRefsKey, model.tabs]);

  // ── Paint context (tables, conditional colors, scale ranges) ──────────────
  const paintCtx = useMemo(() => {
    const tables = model.tables.filter((t) => t.tab === activeTabId);
    const conds = model.conds.filter((c) => c.tab === activeTabId);
    const ranges = new Map<string, { min: number; max: number } | null>();
    return {
      tables,
      conds,
      numericAt: (col: number, row: number) => typeof wb.value(activeTabId, col, row) === "number",
      filterHeader: (col: number, row: number) => !!filter && row === filter.row && col >= filter.c0 && col <= filter.c1,
      inherited: (el: { input?: string }) => (typeof el.input === "string" ? inheritedFormat(model, activeTabId, el.input) : undefined),
      scaleRange: (key: string) => {
        if (ranges.has(key)) return ranges.get(key)!;
        const c = conds.find((x) => x.key === key);
        let min = Infinity, max = -Infinity;
        if (c) for (const row of wb.read(activeTabId, c.rect)) for (const v of row) if (typeof v === "number") { min = Math.min(min, v); max = Math.max(max, v); }
        const r = Number.isFinite(min) ? { min, max } : null;
        ranges.set(key, r);
        return r;
      },
    };
  }, [model, activeTabId, wb, version, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Editor placement (follows scroll) ─────────────────────────────────────
  const editState = useSyncExternalStore(edit.subscribe, () => {
    const s = edit.get();
    return s ? `${s.col},${s.row},${s.surface}` : "";
  }, () => "");
  const editorCell = editState ? { col: Number(editState.split(",")[0]), row: Number(editState.split(",")[1]) } : active;
  const [placement, setPlacement] = useState<EditorPlacement>({ x: ROW_HEADER_W, y: COL_HEADER_H, w: DEF_COL_W, h: DEF_ROW_H, visible: true, align: "left" });
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const r = cellViewportRect(el, cols, rows, frozenCols, frozenRows, editorCell.col, editorCell.row);
    const info = wb.cell(activeTabId, editorCell.col, editorCell.row);
    const align = typeof info?.value === "number" ? "right" : "left";
    const clampX = Math.max(ROW_HEADER_W, Math.min(r.x, el.clientWidth - 40));
    const clampY = Math.max(COL_HEADER_H, Math.min(r.y, el.clientHeight - 20));
    setPlacement((p) => (p.x === clampX && p.y === clampY && p.w === r.w && p.h === r.h && p.align === align ? p : { x: clampX, y: clampY, w: r.w, h: r.h, visible: r.visible, align }));
  }, [editorCell.col, editorCell.row, cols, rows, frozenCols, frozenRows, scrollTick, wb, activeTabId, version]);
  const onScroll = useCallback(() => {
    if (edit.get()) setScrollTick((t) => t + 1);
  }, [edit]);

  // Leaving a tab or the doc commits the edit in progress.
  useEffect(() => () => { if (edit.get()) commitEdit(); }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live query tabs refresh themselves while open ─────────────────────────
  const { refreshing, refresh, lastError } = useQueryTabRefresh(doc._id, tab.meta, readOnlyDoc);
  const now = useCoarseNow(15_000);

  // ── Selection summary ─────────────────────────────────────────────────────
  const summaryValues = useMemo(() => {
    if (rect.c0 === rect.c1 && rect.r0 === rect.r1) return [];
    const r1 = Math.min(rect.r1, Math.max(tab.rows, rect.r0)), c1 = Math.min(rect.c1, Math.max(tab.cols, rect.c0));
    if ((r1 - rect.r0 + 1) * (c1 - rect.c0 + 1) > 200_000) return [];
    // Rows a filter hides are not part of what the person sees, so they are not summed.
    return wb.read(activeTabId, { ...rect, r1, c1 }).filter((_, i) => !hiddenRows.has(rect.r0 + i)).flat();
  }, [rect.c0, rect.r0, rect.c1, rect.r1, wb, version, activeTabId, tab.rows, tab.cols, hiddenRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeInfo = wb.cell(activeTabId, active.col, active.row);
  const refLabel = rect.c0 === rect.c1 && rect.r0 === rect.r1 ? a1(active.col, active.row) : rectA1({ ...rect, r1: Math.min(rect.r1, rows.count), c1: Math.min(rect.c1, cols.count) });

  const onJump = useCallback((text: string) => {
    if (!text.trim()) {
      sinkRef.current?.focus({ preventScroll: true });
      return true;
    }
    const q = parseQualifiedRange(text.trim());
    if (!q) return false;
    const t = q.tab ? S.current.model.tabs.find((x) => x.name.toLowerCase() === q.tab!.toLowerCase()) : null;
    if (q.tab && !t) return false;
    if (t) showTab(t.id);
    select({ anchor: { col: q.rect.c0, row: q.rect.r0 }, focus: { col: q.rect.c1, row: q.rect.r1 } });
    sinkRef.current?.focus({ preventScroll: true });
    return true;
  }, [select, showTab]);

  const onAsk = useCallback((prompt: string, target: "new" | "pick") => {
    const { activeTabId, rect, tab } = S.current;
    const range = `${quoteTabName(tab.meta.name)}!${rectA1(rect)}`;
    const keys: string[] = [];
    for (let r = rect.r0; r <= Math.min(rect.r1, rect.r0 + 39); r++)
      for (let c = rect.c0; c <= Math.min(rect.c1, rect.c0 + 25); c++) if (tab.cells.has(cellNum(c, r))) keys.push(`c:${activeTabId}!${a1(c, r)}`);
    const selected = S.current.model.byId.get(activeTabId) ? keys.slice(0, 40).map((k) => ({ key: k, kind: "cell", rev: 0, ...(tab.cells.get(cellNumOfKey(k)) ?? {}) })) : [];
    const req = { slot: SHEET_ASK_SLOT, prompt: `${prompt}\n\nSelected range: ${range}`, selected: selected as any };
    if (target === "new") void sendAsk(doc, req, { kind: "new" });
    else pickAskTarget("Ask which agent?", (t) => void sendAsk(doc, req, t), () => reopenAsk(doc, SHEET_ASK_SLOT));
  }, [doc]);

  // ── Tab actions ───────────────────────────────────────────────────────────
  const addTab = useCallback((extra?: { query: { source: QuerySource; project?: string }; name: string }) => {
    const { model } = S.current;
    const name = extra?.name ?? uniqueTabName(model, `Sheet${model.tabs.length + 1}`);
    const add = addTabOps(model, name, extra ? { query: extra.query as any, frozen_rows: 1 } : {});
    // The implicit first tab gets an element so the new one sorts after it.
    const ensureFirst = model.tabs.length === 1 && !elementsHaveTab(elements, model.tabs[0].id) ? tabPatchOps(model, model.tabs[0].id, {}) : [];
    apply([...ensureFirst, ...add.ops]);
    setTabId(add.id);
    requestAnimationFrame(() => showTab(add.id));
    select({ anchor: { col: 1, row: 1 }, focus: { col: 1, row: 1 } });
  }, [apply, select, elements, showTab]);
  const addMenu = useContextMenu<null>();
  const [findOpen, setFindOpen] = useState(false);
  /** Every cell of the tab whose shown text or formula holds the query, in reading order. */
  const findMatches = useCallback((q: string) => {
    const { tab: t, wb: w, activeTabId: id, hiddenRows: hid } = S.current;
    if (!q) return [] as Array<{ col: number; row: number }>;
    const needle = q.toLowerCase();
    const out: Array<{ col: number; row: number }> = [];
    for (const [n, el] of t.cells) {
      const col = n % 32768, row = Math.floor(n / 32768);
      if (hid.has(row)) continue;
      const info = w.cell(id, col, row);
      const shown = info ? formatValue(info.value, styleOf(el), info.implied) : "";
      if (shown.toLowerCase().includes(needle) || (typeof el.input === "string" && el.input.toLowerCase().includes(needle))) out.push({ col, row });
    }
    return out.sort((a, b) => a.row - b.row || a.col - b.col);
  }, []);
  const [renameTab, setRenameTab] = useState<string | null>(null);

  // Top-bar controls: none beyond the shell's for now.
  useEffect(() => {
    setToolbar(null);
  }, [setToolbar]);

  const projectName = doc.project_path?.split("/").filter(Boolean).pop();

  return (
    <div className="sheet-root" data-sheet-root data-sheet-tab={tab.meta.name}>
      <FormulaBar
        edit={edit}
        refLabel={refLabel}
        activeInput={activeInfo?.input ?? ""}
        error={activeInfo && typeof activeInfo.value === "object" && activeInfo.value && "error" in activeInfo.value ? `${activeInfo.value.error}${activeInfo.value.message ? ` ${activeInfo.value.message}` : ""}` : undefined}
        readOnly={readOnly}
        onJump={onJump}
        onBeginBarEdit={() => beginEdit(null, "edit", "bar")}
        onKey={onKey}
      />
      {queryTab && (
        <div className="sheet-query-bar" data-sheet-query>
          <Radio className="w-3.5 h-3.5 text-sol-green" />
          <span className="text-sol-text">Live</span>
          <span className="sheet-query-chip">{tab.meta.query!.source}</span>
          {tab.meta.query!.project && <span className="sheet-query-chip">{tab.meta.query!.project}</span>}
          <span className="text-sol-text-dim">{tab.meta.refreshedAt ? `updated ${ago(tab.meta.refreshedAt, now)}` : "not loaded yet"}</span>
          {(lastError || tab.meta.queryError) && <span className="text-sol-red truncate">{lastError ?? tab.meta.queryError}</span>}
          <span className="flex-1" />
          <button type="button" className="sheet-query-refresh" onClick={refresh} disabled={refreshing || readOnlyDoc}>
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      )}
      <div className="sheet-body">
        {!live.ready && !snapshot && <div className="sheet-loading" role="progressbar" aria-label="Loading sheet" />}
        <SheetGrid
          tab={tab}
          wb={wb}
          version={version}
          cols={cols}
          rows={rows}
          frozenRows={frozenRows}
          frozenCols={frozenCols}
          sel={rect}
          active={active}
          outlines={outlines}
          paintCtx={paintCtx}
          filterCols={new Set(Object.entries(filter?.hidden ?? {}).filter(([, v]) => v.length).map(([c]) => Number(c)))}
          filterRow={filter ? filter.row : null}
          flash={flash}
          readOnly={readOnly}
          scrollerRef={scrollerRef}
          onAutoFit={onAutoFit}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onResizeStart={onResizeStart}
          onFillStart={onFillStart}
          onFilterClick={onFilterClick}
          onScroll={onScroll}
        />
        {findOpen && (
          <FindBar
            find={findMatches}
            onGo={(c) => select({ anchor: c, focus: c })}
            from={() => S.current.sel.anchor}
            onClose={() => {
              setFindOpen(false);
              sinkRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
        {filter && <FilterButtons tab={tab} filter={filter} cols={cols} rows={rows} frozenCols={frozenCols} frozenRows={frozenRows} scrollerRef={scrollerRef} scrollTick={scrollTick} onOpen={onFilterClick} />}
        <CellEditor
          edit={edit}
          sinkRef={sinkRef}
          placement={placement}
          readOnly={readOnly}
          onKey={onKey}
          onBegin={(text) => beginEdit(text, "enter")}
          onCopy={copySelection}
          onCut={cutSelection}
          onPaste={pasteInto}
          onCaret={(c) => { caretRef.current = c; }}
        />
        <FormatBar docId={doc._id} style={activeStyle} onAction={onFormat} readOnly={readOnlyDoc || loading} selectionLabel={refLabel} tabName={tab.meta.name} autoAsk={tab.rows === 0 && !queryTab} onAsk={onAsk} />
      </div>
      <TabStrip
        tabs={model.tabs}
        activeId={activeTabId}
        readOnly={readOnlyDoc}
        onSelect={(id) => {
          const st = edit.get();
          // Mid-formula after an operator, another tab is a place to point at: keep the edit open in the bar.
          if (st && wantsReference(st.text, caretRef.current)) edit.patch({ surface: "bar" });
          else if (st) commitEdit();
          // Each tab keeps its own selection and scroll, like Sheets.
          const el = scrollerRef.current;
          tabMemory.current.set(activeTabId, { sel, left: el?.scrollLeft ?? 0, top: el?.scrollTop ?? 0 });
          const back = tabMemory.current.get(id);
          showTab(id);
          setCopyRect(null);
          select(back?.sel ?? { anchor: { col: 1, row: 1 }, focus: { col: 1, row: 1 } }, { reveal: false });
          requestAnimationFrame(() => scrollerRef.current?.scrollTo({ left: back?.left ?? 0, top: back?.top ?? 0 }));
        }}
        onRename={(id, name) => apply(renameTabOps(S.current.model, id, uniqueTabName({ ...S.current.model, tabs: S.current.model.tabs.filter((t) => t.id !== id) }, name)))}
        onContext={(id, e) => menu.open(e, { kind: "tab", tabId: id }, { force: true })}
        renameRequest={renameTab}
        onRenameDone={() => setRenameTab(null)}
        onAdd={(e) => addMenu.open(e, null, { force: true })}
        summary={<SelectionSummary values={summaryValues} style={activeStyle} />}
      />

      <ContextMenu state={addMenu}>
        {() => (
          <>
            <CtxItem onSelect={() => addTab()}>Blank tab</CtxItem>
            <DropdownMenuSeparator />
            {(["tasks", "sessions", "prs", "metrics"] as const).map((src) => (
              <CtxItem key={src} icon={Radio} onSelect={() => addTab({ name: uniqueTabName(S.current.model, QUERY_LABEL[src]), query: { source: src, ...(projectName && src !== "metrics" ? { project: projectName } : {}) } })}>
                Live {QUERY_LABEL[src].toLowerCase()}
              </CtxItem>
            ))}
          </>
        )}
      </ContextMenu>

      <ContextMenu state={menu}>
        {(m) =>
          m.kind === "tab" ? (
            <TabMenu
              tabId={m.tabId}
              model={model}
              onRename={() => setRenameTab(m.tabId)}
              onDelete={() => {
                if (model.tabs.length === 1) return;
                const name = model.byId.get(m.tabId)?.meta.name ?? "tab";
                apply(deleteTabOps(model, m.tabId));
                if (m.tabId === activeTabId) showTab(model.tabs.find((t) => t.id !== m.tabId)!.id);
                toast(`Deleted ${name}`, { action: { label: "Undo", onClick: () => live.undo() }, duration: 8000 });
              }}
            />
          ) : (
            <CellMenu kind={m.kind} readOnly={readOnly} onFormat={onFormat} onClear={() => apply(clearVisible(model, activeTabId, rect, hiddenRows))} onCopyHint={() => {
              const { rect: r, tab: t } = S.current;
              const lines = visibleRowsOf(r, hiddenRows, t.rows).map((row) => {
                const out: string[] = [];
                for (let c = r.c0; c <= Math.min(r.c1, Math.max(t.cols, r.c0)); c++) {
                  const info = wb.cell(activeTabId, c, row);
                  out.push(info ? formatValue(info.value, styleOf(t.cells.get(cellNum(c, row))), info.implied) : "");
                }
                return out;
              });
              void navigator.clipboard.writeText(toTsv(lines)).then(() => toast("Copied"));
            }} />
          )
        }
      </ContextMenu>

      <CursorPopover state={filterPop}>
        {(p) => (
          <FilterPanel
            values={columnValues(wb, tab, p.col, filter?.row ?? 1)}
            hidden={filter?.hidden?.[String(p.col)] ?? []}
            onApply={(hidden) => {
              const f = S.current.tab.meta.filter;
              if (!f) return;
              apply(tabPatchOps(S.current.model, activeTabId, { filter: { ...f, hidden: { ...f.hidden, [String(p.col)]: hidden } } as any }));
              filterPop.close();
            }}
          />
        )}
      </CursorPopover>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The selection's visible rows: a filtered range copies what is on screen. */
function visibleRowsOf(rect: Rect, hidden: Set<number>, maxRow: number): number[] {
  const out: number[] = [];
  for (let r = rect.r0; r <= Math.min(rect.r1, Math.max(maxRow, rect.r0)); r++) if (!hidden.has(r)) out.push(r);
  return out;
}

/** Clear contents of the rows a person can see (a filter's hidden rows stay as they are). */
function clearVisible(model: SheetModel, tabId: string, rect: Rect, hidden: Set<number>) {
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

/** F4: the reference at the caret, cycled A1 -> $A$1 -> A$1 -> $A1 -> A1. */
export function cycleAnchors(text: string, caret: number): { text: string; caret: number } | null {
  if (!isFormula(text)) return null;
  let toks;
  try {
    toks = tokenize(text.slice(1));
  } catch {
    return null;
  }
  const at = caret - 1;
  const t = toks.find((x) => x.type === "ref" && at >= x.start && at <= x.end) as Extract<ReturnType<typeof tokenize>[number], { type: "ref" }> | undefined;
  if (!t || t.shape === "cols" || t.shape === "rows") return null;
  const next = (p: { absCol: boolean; absRow: boolean }) =>
    !p.absCol && !p.absRow ? { absCol: true, absRow: true } : p.absCol && p.absRow ? { absCol: false, absRow: true } : !p.absCol && p.absRow ? { absCol: true, absRow: false } : { absCol: false, absRow: false };
  const a = { ...t.a, ...next(t.a) };
  const b = t.b ? { ...t.b, ...next(t.a) } : undefined;
  const body = refText({ ...t, a, b });
  const out = "=" + text.slice(1, 1 + t.start) + body + text.slice(1 + t.end);
  return { text: out, caret: 1 + t.start + body.length };
}

const QUERY_LABEL: Record<QuerySource, string> = { tasks: "Tasks", sessions: "Sessions", prs: "Pull requests", metrics: "Metrics" };

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cellNumOfKey(key: string): number {
  const m = key.match(/!([A-Z]+)(\d+)$/)!;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return cellNum(col, Number(m[2]));
}

function elementsHaveTab(elements: readonly { key: string }[], tabId: string): boolean {
  return elements.some((e) => e.key === `tab:${tabId}`);
}

function shiftFormulaSafe(input: string, dc: number, dr: number): string {
  return shiftFormula(input, dc, dr);
}

/** The contiguous block of data around a cell (Sheets' "current region"). */
function dataRegion(tab: TabData, col: number, row: number): Rect {
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

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** A first row of text over a column of numbers reads as a header. */
function isHeaderRow(wb: Workbook, tabId: string, r: Rect): boolean {
  if (r.r1 <= r.r0) return false;
  let textTop = 0, numBelow = 0;
  for (let c = r.c0; c <= r.c1; c++) {
    if (typeof wb.value(tabId, c, r.r0) === "string") textTop++;
    if (typeof wb.value(tabId, c, r.r0 + 1) === "number") numBelow++;
  }
  return textTop === r.c1 - r.c0 + 1 || (textTop > 0 && numBelow > 0);
}

function columnValues(wb: Workbook, tab: TabData, col: number, headerRow: number): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (let r = headerRow + 1; r <= tab.rows; r++) {
    const info = wb.cell(tab.meta.id, col, r);
    const text = info ? formatValue(info.value, styleOf(tab.cells.get(cellNum(col, r))), info.implied) : "";
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => (a.text === "" ? 1 : b.text === "" ? -1 : a.text.localeCompare(b.text, undefined, { numeric: true })));
}

/** References in the formula being typed, as "tab|A1:B2;..." so the grid can color them. */
function refsKeyOf(text: string | undefined): string {
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

function TabMenu({ tabId, model, onRename, onDelete }: { tabId: string; model: SheetModel; onRename: () => void; onDelete: () => void }) {
  const t = model.byId.get(tabId);
  if (!t) return null;
  return (
    <>
      <CtxItem onSelect={onRename} disabled={!!t.meta.query}>Rename</CtxItem>
      <CtxItem danger onSelect={onDelete} disabled={model.tabs.length === 1}>Delete tab</CtxItem>
    </>
  );
}

function CellMenu({ kind, readOnly, onFormat, onClear, onCopyHint }: { kind: "cell" | "colHeader" | "rowHeader"; readOnly: boolean; onFormat: (a: FormatAction) => void; onClear: () => void; onCopyHint: () => void }) {
  if (readOnly) return <CtxItem onSelect={onCopyHint}>Copy</CtxItem>;
  return (
    <>
      {kind !== "colHeader" && (
        <>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "row", after: false })}>Insert row above</CtxItem>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "row", after: true })}>Insert row below</CtxItem>
        </>
      )}
      {kind !== "rowHeader" && (
        <>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "col", after: false })}>Insert column left</CtxItem>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "col", after: true })}>Insert column right</CtxItem>
        </>
      )}
      <DropdownMenuSeparator />
      {kind !== "colHeader" && <CtxItem danger onSelect={() => onFormat({ type: "delete", axis: "row" })}>Delete rows</CtxItem>}
      {kind !== "rowHeader" && <CtxItem danger onSelect={() => onFormat({ type: "delete", axis: "col" })}>Delete columns</CtxItem>}
      <DropdownMenuSeparator />
      <CtxItem onSelect={() => onFormat({ type: "sort", desc: false })}>Sort A to Z</CtxItem>
      <CtxItem onSelect={() => onFormat({ type: "sort", desc: true })}>Sort Z to A</CtxItem>
      <CtxItem icon={FilterIcon} onSelect={() => onFormat({ type: "filter" })}>Filter</CtxItem>
      {kind !== "colHeader" && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "row" })}>Freeze rows to here</CtxItem>}
      {kind !== "rowHeader" && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "col" })}>Freeze columns to here</CtxItem>}
      <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "none" })}>Unfreeze</CtxItem>
      <DropdownMenuSeparator />
      <CtxItem onSelect={onClear}>Clear contents</CtxItem>
    </>
  );
}

function FilterPanel({ values, hidden, onApply }: { values: Array<{ text: string; count: number }>; hidden: string[]; onApply: (hidden: string[]) => void }) {
  const [off, setOff] = useState(() => new Set(hidden));
  const [q, setQ] = useState("");
  const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="sheet-filter-panel" data-sheet-filter-panel>
      <input autoFocus placeholder="Search values" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="sheet-filter-actions">
        <button type="button" onClick={() => setOff(new Set())}>All</button>
        <button type="button" onClick={() => setOff(new Set(values.map((v) => v.text)))}>None</button>
      </div>
      <div className="sheet-filter-list">
        {shown.map((v) => {
          const on = !off.has(v.text);
          return (
            <button
              type="button"
              key={v.text}
              className={on ? "is-on" : ""}
              onClick={() => setOff((s) => {
                const n = new Set(s);
                if (n.has(v.text)) n.delete(v.text);
                else n.add(v.text);
                return n;
              })}
            >
              <span className="sheet-check">{on && <Check className="w-3 h-3" />}</span>
              <span className="truncate flex-1 text-left">{v.text === "" ? "(blank)" : v.text}</span>
              <span className="text-sol-text-dim tabular-nums">{v.count}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="sheet-filter-ok" onClick={() => onApply([...off])}>Apply</button>
    </div>
  );
}

function FilterButtons({
  tab,
  filter,
  cols,
  rows,
  frozenCols,
  frozenRows,
  scrollerRef,
  scrollTick,
  onOpen,
}: {
  tab: TabData;
  filter: NonNullable<TabData["meta"]["filter"]>;
  cols: AxisLayout;
  rows: AxisLayout;
  frozenCols: number;
  frozenRows: number;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  scrollTick: number;
  onOpen: (col: number, e: React.MouseEvent) => void;
}) {
  // Re-place on scroll: one cheap pass over the filtered columns.
  const [, force] = useState(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        force((n) => n + 1);
      });
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [scrollerRef]);
  void scrollTick;
  void tab;
  const el = scrollerRef.current;
  if (!el) return null;
  const out = [];
  for (let c = filter.c0; c <= filter.c1; c++) {
    const r = cellViewportRect(el, cols, rows, frozenCols, frozenRows, c, filter.row);
    if (!r.visible || r.x + r.w > el.clientWidth || r.y < COL_HEADER_H - 2 || r.y > el.clientHeight) continue;
    const active = (filter.hidden?.[String(c)] ?? []).length > 0;
    out.push(
      <button
        key={c}
        type="button"
        data-sheet-filter={c}
        aria-label={`Filter column ${a1(c, 1).replace(/\d+/, "")}`}
        className={`sheet-filter-btn ${active ? "is-active" : ""}`}
        style={{ left: r.x + r.w - 20, top: r.y + (r.h - 18) / 2 }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => onOpen(c, e)}
      >
        <FilterIcon className="w-3 h-3" />
      </button>,
    );
  }
  return <>{out}</>;
}

/** ⌘F: find text or formulas on this tab; Enter goes to the next match, Shift+Enter back. */
function FindBar({ find, onGo, from, onClose }: { find: (q: string) => Array<{ col: number; row: number }>; onGo: (c: { col: number; row: number }) => void; from: () => { col: number; row: number }; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const matches = useMemo(() => find(q), [find, q]);
  const go = (dir: 1 | -1) => {
    if (!matches.length) return;
    let i: number;
    if (at === null) {
      const f = from();
      i = matches.findIndex((m) => m.row > f.row || (m.row === f.row && m.col >= f.col));
      if (i < 0) i = 0;
    } else i = (at + dir + matches.length) % matches.length;
    setAt(i);
    onGo(matches[i]);
  };
  return (
    <div className="sheet-find" data-sheet-find onPointerDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        placeholder="Find"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="sheet-find-count">{q ? `${at === null ? 0 : at + 1}/${matches.length}` : ""}</span>
      <button type="button" aria-label="Close find" onClick={onClose}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
