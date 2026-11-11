// Dropdown and date cells, the dropdown editor, the error card on hover and
// file import: the state and handlers SheetView mounts, kept here so the view
// stays a layout. SheetExtras.tsx draws them.
import { createElement, useCallback, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { CondPanel } from "./CondPanel";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { toast } from "sonner";
import { a1, rectA1, cellNum, importTablesOps, inputOps, parseKey, tabKey, validationAt, validationOps, type Rect } from "./sheetCore";
import { cellViewportRect, hitTest } from "./gridGeometry";
import { readSheetFile } from "./importFile";
import { linkOf } from "./cellPaint";
import { useContextMenu, type ContextMenuState } from "../ui/context-menu";
import { useLiveComments, type LiveHandle } from "../live/useLiveArtifact";
import { groupThreads, type LiveThread } from "../live/liveThreads";
import type { ArtifactOp } from "@codecast/shared/artifacts";
import type { Sel, SheetState } from "./sheetActions";

export type SheetExtrasDeps = {
  S: MutableRefObject<SheetState>;
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  sinkRef: MutableRefObject<HTMLTextAreaElement | null>;
  select: (next: Sel, opts?: { reveal?: boolean }) => void;
  apply: (ops: ArtifactOp[]) => void;
  menu: ContextMenuState<any>;
  live: LiveHandle;
  showTab: (id: string, name?: string) => void;
  docId: string;
  openComments: (opts?: { anchor?: string; thread?: string }) => void;
  setPanel: (node: ReactNode | null) => void;
  /** The shell's selection: a comment thread opened in the panel points it at its cell. */
  selection: string[];
};

export function useSheetExtras({ S, scrollerRef, sinkRef, select, apply, menu, live, showTab, docId, openComments, setPanel, selection }: SheetExtrasDeps) {
  const { model, activeTabId, wb, sel } = S.current;
  const active = sel.anchor;

  // ── Cell comments: open threads anchored to this tab's cells ──────────────
  const comments = useLiveComments(docId);
  const commentCells = useMemo(() => {
    const out = new Map<number, LiveThread>();
    for (const t of groupThreads(comments)) {
      const k = typeof t.root.anchor === "string" && !t.root.resolved ? parseKey(t.root.anchor) : null;
      if (k?.type === "cell" && k.tab === activeTabId && !out.has(cellNum(k.col, k.row))) out.set(cellNum(k.col, k.row), t);
    }
    return out;
  }, [comments, activeTabId]);
  const commentCellsRef = useRef(commentCells);
  commentCellsRef.current = commentCells;
  /** Comment on the active cell: its open thread, or a new comment anchored to it. */
  const openCellComment = useCallback((col?: number, row?: number) => {
    const { activeTabId: id, sel: s } = S.current;
    const c = col ?? s.anchor.col, r = row ?? s.anchor.row;
    const thread = commentCellsRef.current.get(cellNum(c, r));
    openComments(thread ? { thread: thread.root.key } : { anchor: `c:${id}!${a1(c, r)}` });
  }, [S, openComments]);
  // ── Dropdown and date pickers ─────────────────────────────────────────────
  const pickerPop = useContextMenu<{ tab: string; col: number; row: number; query?: string }>();
  const openPicker = useCallback((col?: number, row?: number, query?: string) => {
    const { model, activeTabId, sel, readOnly, cols: cl, rows: rl, frozenCols: fc, frozenRows: fr } = S.current;
    const c = col ?? sel.anchor.col, r = row ?? sel.anchor.row;
    const el = scrollerRef.current;
    if (readOnly || !el || !validationAt(model, activeTabId, c, r)) return false;
    if (col !== undefined) select({ anchor: { col: c, row: r }, focus: { col: c, row: r } }, { reveal: false });
    const box = el.getBoundingClientRect();
    const v = cellViewportRect(el, cl, rl, fc, fr, c, r);
    pickerPop.openAt(box.left + v.x, box.top + v.y + v.h + 2, { tab: activeTabId, col: c, row: r, query });
    return true;
  }, [S, scrollerRef, pickerPop, select]);
  const pickValue = useCallback((p: { tab: string; col: number; row: number }, input: string) => {
    pickerPop.close();
    apply(inputOps(S.current.model, p.tab, [{ col: p.col, row: p.row, input }]));
    sinkRef.current?.focus({ preventScroll: true });
  }, [S, sinkRef, pickerPop, apply]);
  /** Add a typed value to the cell's dropdown and write it, as one step. */
  const addOption = useCallback((p: { tab: string; col: number; row: number }, value: string) => {
    pickerPop.close();
    const m = S.current.model;
    const v = validationAt(m, p.tab, p.col, p.row);
    if (!v) return;
    const palette = ["blue", "green", "orange", "violet", "cyan", "magenta", "yellow", "red", "gray"] as const;
    const color = palette[v.options.length % palette.length];
    // One batch, straight to the doc: the cell's value is valid only together with the option it adds.
    live.apply([...validationOps(m, p.tab, v.rect, "list", [...v.options, { v: value, color }], v.strict), ...inputOps(m, p.tab, [{ col: p.col, row: p.row, input: value }])]);
    sinkRef.current?.focus({ preventScroll: true });
  }, [S, sinkRef, pickerPop, live]);
  const activeValidation = validationAt(model, activeTabId, active.col, active.row);

  // ── Dropdown editor (from the cell menu) ──────────────────────────────────
  const dvPop = useContextMenu<{ tab: string; rect: Rect }>();
  /** The range a dropdown covers: the selection, minus a header row when whole columns are selected. */
  const validationRect = useCallback((): Rect => {
    const { rect: r, rows: rl, wb: w, activeTabId: id } = S.current;
    const wholeCols = r.r0 === 1 && r.r1 >= rl.count;
    const header = wholeCols && typeof w.value(id, r.c0, 1) === "string";
    return { ...r, r0: header ? 2 : r.r0, r1: wholeCols ? Math.max(rl.count, 1000) : r.r1 };
  }, [S]);
  const onValidate = useCallback((kind: "list" | "date" | "none") => {
    const { model: m, activeTabId: id, sel } = S.current;
    // Editing or removing an existing dropdown acts on its own range, not just the clicked cell.
    const r = validationAt(m, id, sel.anchor.col, sel.anchor.row)?.rect ?? validationRect();
    if (kind === "list") {
      const at = menu.menu ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 };
      dvPop.openAt(at.x, at.y, { tab: id, rect: r });
      return;
    }
    apply(validationOps(m, id, r, kind === "date" ? "date" : null));
  }, [apply, dvPop, validationRect]); // eslint-disable-line react-hooks/exhaustive-deps
  /** What the editor opens with: the range's dropdown, else the distinct values already typed there. */
  const dropdownSeed = (p: { tab: string; rect: Rect }) => {
    const existing = validationAt(model, p.tab, p.rect.c0, p.rect.r0);
    if (existing?.rule === "list") return { options: existing.options, strict: existing.strict, has: true };
    const seen = new Map<string, string>();
    const t = model.byId.get(p.tab);
    for (const [n, el] of t?.cells ?? []) {
      const col = n % 32768, row = Math.floor(n / 32768);
      if (col < p.rect.c0 || col > p.rect.c1 || row < p.rect.r0 || row > p.rect.r1 || typeof el.input !== "string" || !el.input || el.input.startsWith("=")) continue;
      const v = el.input.trim();
      if (!seen.has(v.toLowerCase()) && seen.size < 24) seen.set(v.toLowerCase(), v);
    }
    const palette = ["blue", "green", "orange", "violet", "cyan", "magenta", "yellow", "red", "gray"] as const;
    return { options: [...seen.values()].map((v, i) => ({ v, color: palette[i % palette.length] })), strict: false, has: false };
  };

  // ── Error cells explain themselves on hover ───────────────────────────────
  const [errHover, setErrHover] = useState<{ col: number; row: number; x: number; y: number; above: boolean; kind: "error" | "comment" | "invalid" | "link" } | null>(null);
  const hoverRef = useRef<{ key: string }>({ key: "" });
  const onGridHover = useCallback((e: React.PointerEvent) => {
    const el = scrollerRef.current;
    if (!el || e.buttons !== 0 || (e.target as HTMLElement).closest("[data-sheet-error-pop]")) return;
    const { cols: cl, rows: rl, frozenCols: fc, frozenRows: fr, wb: w, activeTabId: id } = S.current;
    const hit = hitTest(el, cl, rl, cl.offset(fc + 1), rl.offset(fr + 1), e.clientX, e.clientY);
    const key = hit.zone === "cell" ? `${hit.col}:${hit.row}` : "";
    const h = hoverRef.current;
    if (key === h.key) return;
    h.key = key;
    const v = hit.zone === "cell" ? w.value(id, hit.col, hit.row) : null;
    const isError = !!v && typeof v === "object" && "error" in v;
    const hasComment = hit.zone === "cell" && commentCellsRef.current.has(cellNum(hit.col, hit.row));
    const dv = hit.zone === "cell" && v !== null && v !== "" ? validationAt(S.current.model, id, hit.col, hit.row) : undefined;
    const invalid = !!dv && (dv.rule === "list" ? !dv.options.some((o) => o.v.toLowerCase() === String(v).toLowerCase()) : typeof v !== "number");
    const link = hit.zone === "cell" ? linkOf(w.cell(id, hit.col, hit.row)?.input ?? "") : null;
    if (hit.zone !== "cell" || (!isError && !hasComment && !invalid && !link)) {
      setErrHover((cur) => (cur ? null : cur));
      return;
    }
    // Shown at once; the card's own fade-in delay keeps a pass over the grid from flashing it.
    const r = cellViewportRect(el, cl, rl, fc, fr, hit.col, hit.row);
    // The card stays inside the pane: pulled left at the right edge, and above the cell near the bottom.
    const CARD_W = 330, CARD_H = 200;
    const x = Math.max(4, Math.min(r.x, el.clientWidth - CARD_W - 4));
    const above = r.y + r.h + CARD_H > el.clientHeight && r.y > CARD_H;
    setErrHover({ col: hit.col, row: hit.row, x, y: above ? r.y - 4 : r.y + r.h + 4, above, kind: isError ? "error" : invalid ? "invalid" : hasComment ? "comment" : "link" });
  }, [S, scrollerRef]);
  const errInfo = errHover ? wb.cell(activeTabId, errHover.col, errHover.row) : null;
  const errValue = errInfo && typeof errInfo.value === "object" && errInfo.value && "error" in errInfo.value ? errInfo.value : null;

  // ── Import a CSV / TSV / XLSX file as new tabs ────────────────────────────
  const importFiles = useCallback(async (files: FileList | File[]) => {
    if (S.current.readOnlyDoc) return;
    for (const file of Array.from(files)) {
      try {
        const tables = await readSheetFile(file);
        const r = importTablesOps(S.current.model, tables);
        apply(r.ops);
        if (r.tabIds[0]) {
          const first = r.ops.find((op) => op.k === tabKey(r.tabIds[0]));
          showTab(r.tabIds[0], first && "put" in first && typeof first.put.name === "string" ? first.put.name : undefined);
        }
        toast(`Imported ${tables.length === 1 ? tables[0].name : `${tables.length} sheets`} from ${file.name}`, { action: { label: "Undo", onClick: () => live.undo() } });
      } catch (x) {
        toast.error(x instanceof Error ? x.message : `Couldn't read ${file.name}`);
      }
    }
  }, [S, apply, live, showTab]);
  const [dropping, setDropping] = useState(false);

  // ── The shell pointing at a cell (a comment thread opened in the panel) ───
  // The sheet's own selection reports keys inside its selection, so only a key
  // outside it is someone else asking to go there.
  useWatchEffect(() => {
    if (selection.length !== 1) return;
    const k = parseKey(selection[0]);
    if (k?.type !== "cell") return;
    const { activeTabId: id, rect } = S.current;
    if (k.tab === id && k.col >= rect.c0 && k.col <= rect.c1 && k.row >= rect.r0 && k.row <= rect.r1) return;
    if (k.tab !== id) showTab(k.tab);
    select({ anchor: { col: k.col, row: k.row }, focus: { col: k.col, row: k.row } });
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Conditional color rules, in the shell's side panel ────────────────────
  const openRules = useCallback(() => {
    const { activeTabId: id, tab } = S.current;
    setPanel(
      createElement(CondPanel, {
        key: id,
        live,
        tabId: id,
        tabName: tab.meta.name,
        selection: () => rectA1(S.current.rect),
        onClose: () => setPanel(null),
      }),
    );
  }, [S, live, setPanel]);

  const hoverThread = errHover?.kind === "comment" ? commentCells.get(cellNum(errHover.col, errHover.row)) : undefined;

  return { S, model, wb, activeTabId, addOption, openRules, commentCells, openCellComment, hoverThread, pickerPop, openPicker, pickValue, activeValidation, dvPop, onValidate, dropdownSeed, errHover, setErrHover, hoverRef, onGridHover, errInfo, errValue, importFiles, dropping, setDropping };
}

export type SheetExtras = ReturnType<typeof useSheetExtras>;
