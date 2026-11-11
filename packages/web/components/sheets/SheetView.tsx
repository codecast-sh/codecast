// A live sheet: tabs of cells that people and agent sessions edit together.
// Reads come from the doc's elements (useLiveElements), folded into a model
// and a recalculating Workbook held across renders and synced by diff, so an
// edit re-evaluates only what depends on it. Writes are element ops from
// @codecast/shared/artifacts/sheets through live.apply. Other participants'
// selections and an agent's write range are outlined in their color.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Radio } from "lucide-react";
import type { ArtifactPresence } from "@codecast/shared/artifacts";
import { a1, addTabOps, LiveSheet, validationAt, validateInput, cellNum, deleteTabOps, formatValue, inputOps, isFormula, parseQualifiedRange, quoteTabName, rectA1, renameTabOps, styleOf, tabPatchOps, toTsv, fitWidthOps, inheritedFormat, uniqueTabName, type CellStyle, type Rect, type TabData, type QuerySource } from "./sheetCore";
import type { LiveViewProps } from "../live/registry";
import { useLiveElements, useLivePresence } from "../live/useLiveArtifact";
import { sendAsk, pickAskTarget, reopenAsk } from "../live/askAgent";
import { ContextMenu, CursorPopover, CtxItem, useContextMenu } from "../ui/context-menu";
import { DropdownMenuSeparator } from "../ui/dropdown-menu";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { createEditStore, finishInput, wantsReference, type EditStore } from "./editStore";
import { AxisLayout } from "./layout";
import { SheetGrid, type Outline } from "./SheetGrid";
import { ROW_HEADER_W, COL_HEADER_H, BOTTOM_ROOM, cellViewportRect, type GridHit } from "./gridGeometry";
import { CellEditor, FormulaBar, SelectionSummary, TabStrip, type EditorPlacement } from "./SheetChrome";
import { FormatBar, type FormatAction } from "./FormatBar";
import { SHEET_ASK_SLOT } from "./askSlot";
import { useQueryTabRefresh } from "./useQueryTabRefresh";
import { useUnseenTabs } from "./tabActivity";
import { useSheetExtras } from "./useSheetExtras";
import { SheetExtrasView } from "./SheetExtras";
import { IMPORT_ACCEPT } from "./importFile";
import { Upload } from "lucide-react";
import { solVar } from "./cellPaint";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { DEF_COL_W, DEF_ROW_H, REF_COLORS, type Sel, type Menu, selRect, parsePosition, visibleRowsOf, clearVisible, QUERY_LABEL, ago, cellNumOfKey, elementsHaveTab, shiftFormulaSafe, columnValues, refsKeyOf, formatSelection, writeSheetClipboard, pasteSheetClipboard, type SheetState, type SheetCtx } from "./sheetActions";
import { TabMenu, CellMenu, FilterPanel, FilterButtons, FindBar } from "./SheetMenus";
import { handleSheetKey } from "./sheetKeys";
import { sheetPointerDown, sheetResizeStart, sheetFillStart } from "./sheetPointer";
import "./sheet.css";


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
  useWatchEffect(() => {
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
  const S = useRef<SheetState>({ model, wb, tab, activeTabId, sel, rect, cols, rows, frozenRows, frozenCols, readOnly, readOnlyDoc, hiddenRows });
  S.current = { model, wb, tab, activeTabId, sel, rect, cols, rows, frozenRows, frozenCols, readOnly, readOnlyDoc, hiddenRows };
  // The same, plus the handlers and refs, for the event handlers in sheetKeys/sheetPointer/sheetActions.
  const ctx = useRef<SheetCtx>(null!);

  const apply = useCallback((ops: Parameters<typeof live.apply>[0]) => {
    if (ops.length) live.apply(ops);
  }, [live]);

  // Selection -> presence (my range, in this tab) and the shell's Ask selection.
  useWatchEffect(() => {
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
  useWatchEffect(() => {
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
    // A dropdown or date cell checks what was typed: a listed value takes its listed case; a strict cell refuses the rest.
    const checked = validateInput(validationAt(model, e.tab, e.col, e.row), finishInput(e.text));
    if ("refuse" in checked) {
      edit.set(e);
      toast(checked.refuse);
      return;
    }
    const input = checked.input;
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

  const onFormat = useCallback((a: FormatAction) => formatSelection(a, ctx.current), []);

  // ── Clipboard ─────────────────────────────────────────────────────────────

  const writeClipboard = useCallback((e: React.ClipboardEvent, cut: boolean) => writeSheetClipboard(e, cut, ctx.current), []);

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

  const pasteInto = useCallback((e: React.ClipboardEvent) => pasteSheetClipboard(e, ctx.current), []);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const onKey = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, surface: "cell" | "bar") => handleSheetKey(e, surface, ctx.current), []);

  // ── Pointer: select, drag-select, point mode, resize, fill ────────────────
  const dragRef = useRef<{ kind: "cells" | "cols" | "rows" | "fill"; origin: Rect } | null>(null);

  const onPointerDown = useCallback((hit: GridHit, e: React.PointerEvent) => sheetPointerDown(hit, e, ctx.current), []);

  const onDoubleClick = useCallback((hit: GridHit) => {
    if (hit.zone !== "cell") return;
    const v = S.current.wb.value(S.current.activeTabId, hit.col, hit.row);
    // A live-query row names a codecast object: double-click opens it.
    if (queryTabRef.current && typeof v === "string" && /^(ct|pl)-\d+$/.test(v)) {
      router.push(v.startsWith("pl-") ? `/plans/${v}` : `/tasks/${v}`);
      return;
    }
    // A dropdown or date cell opens its picker; typing still edits it as text.
    if (ctx.current.openPicker(hit.col, hit.row)) return;
    beginEdit(null, "edit");
  }, [beginEdit, router]);

  const onResizeStart = useCallback((axis: "col" | "row", index: number, e: React.PointerEvent) => sheetResizeStart(axis, index, e, ctx.current), []);

  const onAutoFit = useCallback((col: number) => {
    if (S.current.readOnlyDoc) return;
    const { model, wb, activeTabId } = S.current;
    apply(fitWidthOps(model, wb, activeTabId, [col]));
  }, [apply]);

  const onFillStart = useCallback((e: React.PointerEvent) => sheetFillStart(e, ctx.current), []);

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
  useWatchEffect(() => {
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
  useWatchEffect(() => { seenRevs.current = null; }, [activeTabId]);

  // ── Others: outlines in their color ───────────────────────────────────────
  const others = useLivePresence(doc._id);
  const unseenTabs = useUnseenTabs(model, activeTabId);
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
    const validations = model.validations.filter((v) => v.tab === activeTabId);
    const ranges = new Map<string, { min: number; max: number } | null>();
    return {
      tables,
      conds,
      validation: validations.length
        ? (col: number, row: number) => {
            for (let i = validations.length - 1; i >= 0; i--) {
              const r = validations[i].rect;
              if (col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1) return validations[i];
            }
            return undefined;
          }
        : undefined,
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
  useWatchEffect(() => () => { if (edit.get()) commitEdit(); }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const x = useSheetExtras({ S, scrollerRef, sinkRef, select, apply, menu, live, showTab, setTabId });
  const { openPicker, onValidate, activeValidation, onGridHover, hoverRef, setErrHover, fileRef, importFiles, dropping, setDropping } = x;

  // Top-bar controls: none beyond the shell's for now.
  useWatchEffect(() => {
    setToolbar(null);
  }, [setToolbar]);

  const projectName = doc.project_path?.split("/").filter(Boolean).pop();

  ctx.current = { S, edit, pointRef, caretRef, scrollerRef, sinkRef, pasteValuesRef, dragRef, live, docId: doc._id, cancelEdit, commitEdit, commitToSelection, move, beginEdit, apply, onFormat, select, setSel, setCopyRect, setFillPreview, setFindOpen, openPicker };

  return (
    <div
      className="sheet-root"
      data-sheet-root
      data-sheet-tab={tab.meta.name}
      data-dropping={dropping ? "" : undefined}
      onDragOver={(e) => {
        if (readOnlyDoc || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        void importFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
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
      <div
        className="sheet-body"
        onPointerMove={onGridHover}
        onPointerLeave={(e) => {
          if ((e.relatedTarget as HTMLElement | null)?.closest?.("[data-sheet-error-pop]")) return;
          hoverRef.current.key = "";
          if (hoverRef.current.timer) clearTimeout(hoverRef.current.timer);
          setErrHover(null);
        }}
      >
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
        <SheetExtrasView x={x} placement={placement} editing={!!editState} readOnly={readOnly} edit={edit} select={select} apply={apply} sinkRef={sinkRef} tabRows={tab.rows} />
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
        others={others}
        unseen={unseenTabs}
      />

      <ContextMenu state={addMenu}>
        {() => (
          <>
            <CtxItem onSelect={() => addTab()}>Blank tab</CtxItem>
            <CtxItem icon={Upload} onSelect={() => fileRef.current?.click()}>Import file</CtxItem>
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
            <CellMenu kind={m.kind} readOnly={readOnly} onFormat={onFormat} validation={activeValidation?.rule} onValidate={onValidate} onClear={() => apply(clearVisible(model, activeTabId, rect, hiddenRows))} onCopyHint={() => {
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
