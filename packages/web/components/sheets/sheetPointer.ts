// The sheet's pointer gestures: select and drag-select (with point mode while
// typing a formula), header resize and the fill handle.
import { a1, cellNum, fillOps, inputOps, isFormula, quoteTabName, colWidthOps, rowHeightOps } from "./sheetCore";
import { wantsReference } from "./editStore";
import { ROW_HEADER_W, COL_HEADER_H, hitTest, type GridHit } from "./gridGeometry";
import { type Sel, selRect, type SheetCtx } from "./sheetActions";

export function sheetPointerDown(hit: GridHit, e: React.PointerEvent, c: SheetCtx) {
  const { S, edit, caretRef, scrollerRef, sinkRef, dragRef, commitEdit, apply, select, setSel } = c;
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
}

export function sheetResizeStart(axis: "col" | "row", index: number, e: React.PointerEvent, c: SheetCtx) {
  const { S, live } = c;
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
}

export function sheetFillStart(e: React.PointerEvent, c: SheetCtx) {
  const { S, scrollerRef, apply, select, setFillPreview } = c;
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
}
