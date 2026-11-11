// Dropdown and date cells, the dropdown editor, the error card on hover and
// file import: the state and handlers SheetView mounts, kept here so the view
// stays a layout. SheetExtras.tsx draws them.
import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";
import { importTablesOps, inputOps, validationAt, validationOps, type Rect } from "./sheetCore";
import { cellViewportRect, hitTest } from "./gridGeometry";
import { readSheetFile } from "./importFile";
import { useContextMenu, type ContextMenuState } from "../ui/context-menu";
import type { LiveHandle } from "../live/useLiveArtifact";
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
  showTab: (id: string) => void;
  setTabId: (id: string) => void;
};

export function useSheetExtras({ S, scrollerRef, sinkRef, select, apply, menu, live, showTab, setTabId }: SheetExtrasDeps) {
  const { model, activeTabId, wb, sel } = S.current;
  const active = sel.anchor;
  // ── Dropdown and date pickers ─────────────────────────────────────────────
  const pickerPop = useContextMenu<{ tab: string; col: number; row: number }>();
  const openPicker = useCallback((col?: number, row?: number) => {
    const { model, activeTabId, sel, readOnly, cols: cl, rows: rl, frozenCols: fc, frozenRows: fr } = S.current;
    const c = col ?? sel.anchor.col, r = row ?? sel.anchor.row;
    const el = scrollerRef.current;
    if (readOnly || !el || !validationAt(model, activeTabId, c, r)) return false;
    if (col !== undefined) select({ anchor: { col: c, row: r }, focus: { col: c, row: r } }, { reveal: false });
    const box = el.getBoundingClientRect();
    const v = cellViewportRect(el, cl, rl, fc, fr, c, r);
    pickerPop.openAt(box.left + v.x, box.top + v.y + v.h + 2, { tab: activeTabId, col: c, row: r });
    return true;
  }, [S, scrollerRef, pickerPop, select]);
  const pickValue = useCallback((p: { tab: string; col: number; row: number }, input: string) => {
    pickerPop.close();
    apply(inputOps(S.current.model, p.tab, [{ col: p.col, row: p.row, input }]));
    sinkRef.current?.focus({ preventScroll: true });
  }, [S, sinkRef, pickerPop, apply]);
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
  const [errHover, setErrHover] = useState<{ col: number; row: number; x: number; y: number } | null>(null);
  const hoverRef = useRef<{ key: string; timer: ReturnType<typeof setTimeout> | null }>({ key: "", timer: null });
  const onGridHover = useCallback((e: React.PointerEvent) => {
    const el = scrollerRef.current;
    if (!el || e.buttons !== 0 || (e.target as HTMLElement).closest("[data-sheet-error-pop]")) return;
    const { cols: cl, rows: rl, frozenCols: fc, frozenRows: fr, wb: w, activeTabId: id } = S.current;
    const hit = hitTest(el, cl, rl, cl.offset(fc + 1), rl.offset(fr + 1), e.clientX, e.clientY);
    const key = hit.zone === "cell" ? `${hit.col}:${hit.row}` : "";
    const h = hoverRef.current;
    if (key === h.key) return;
    h.key = key;
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
    const v = hit.zone === "cell" ? w.value(id, hit.col, hit.row) : null;
    if (hit.zone !== "cell" || !v || typeof v !== "object" || !("error" in v)) {
      setErrHover((cur) => (cur ? null : cur));
      return;
    }
    h.timer = setTimeout(() => {
      const r = cellViewportRect(el, cl, rl, fc, fr, hit.col, hit.row);
      setErrHover({ col: hit.col, row: hit.row, x: r.x, y: r.y + r.h + 4 });
    }, 350);
  }, [S, scrollerRef]);
  const errInfo = errHover ? wb.cell(activeTabId, errHover.col, errHover.row) : null;
  const errValue = errInfo && typeof errInfo.value === "object" && errInfo.value && "error" in errInfo.value ? errInfo.value : null;

  // ── Import a CSV / TSV / XLSX file as new tabs ────────────────────────────
  const fileRef = useRef<HTMLInputElement | null>(null);
  const importFiles = useCallback(async (files: FileList | File[]) => {
    if (S.current.readOnlyDoc) return;
    for (const file of Array.from(files)) {
      try {
        const tables = await readSheetFile(file);
        const r = importTablesOps(S.current.model, tables);
        apply(r.ops);
        if (r.tabIds[0]) {
          setTabId(r.tabIds[0]);
          requestAnimationFrame(() => showTab(r.tabIds[0]));
        }
        toast(`Imported ${tables.length === 1 ? tables[0].name : `${tables.length} sheets`} from ${file.name}`, { action: { label: "Undo", onClick: () => live.undo() } });
      } catch (x) {
        toast.error(x instanceof Error ? x.message : `Couldn't read ${file.name}`);
      }
    }
  }, [S, setTabId, apply, live, showTab]);
  const [dropping, setDropping] = useState(false);

  return { S, model, wb, activeTabId, pickerPop, openPicker, pickValue, activeValidation, dvPop, onValidate, dropdownSeed, errHover, setErrHover, hoverRef, onGridHover, errInfo, errValue, fileRef, importFiles, dropping, setDropping };
}

export type SheetExtras = ReturnType<typeof useSheetExtras>;
