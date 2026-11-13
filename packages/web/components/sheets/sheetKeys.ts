// The sheet's keyboard: editing keys while a cell is open, navigation and
// shortcuts otherwise. Called from SheetView's onKey with the view's SheetCtx.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { fillOps, inputOps, normRect, rectA1 } from "./sheetCore";
import { cycleAnchors, wantsReference } from "./editStore";
import { COL_HEADER_H, BOTTOM_ROOM } from "./gridGeometry";
import { clearVisible, type SheetCtx } from "./sheetActions";

export function handleSheetKey(e: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, surface: "cell" | "bar", c: SheetCtx) {
  const { S, edit, pointRef, caretRef, scrollerRef, pasteValuesRef, live, cancelEdit, commitEdit, commitToSelection, move, beginEdit, apply, onFormat, select, setCopyRect, setFindOpen } = c;
    const mod = e.metaKey || e.ctrlKey;
    const st = edit.get();
    if (st) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === "Enter" && !e.altKey) {
        e.preventDefault();
        const start = c.tabRunRef.current;
        c.tabRunRef.current = null;
        if (mod) commitToSelection();
        else if (start !== null && !e.shiftKey) {
          // Typing a row with Tab, then Enter: back to the column the row started in, like Sheets.
          commitEdit(0, 0);
          if (S.current.activeTabId === st.tab) select({ anchor: { col: start, row: st.row + 1 }, focus: { col: start, row: st.row + 1 } });
        } else commitEdit(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (!e.shiftKey && c.tabRunRef.current === null) c.tabRunRef.current = st.col;
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
        c.tabRunRef.current = null;
        commitEdit(d[0], d[1]);
      }
      if (!e.key.startsWith("Arrow") && e.key !== "Shift") pointRef.current = null;
      return;
    }
    if (surface !== "cell") return;
    const { readOnly, model, activeTabId, rect } = S.current;
    // ⌘⌥M comments on the cell, as in Google Sheets (Option turns M into µ on a Mac, so match the key code).
    if (mod && e.altKey && e.code === "KeyM") {
      e.preventDefault();
      c.openCellComment();
      return;
    }
    // Alt+Down opens a dropdown or date cell's picker, as in Sheets and Excel.
    if (e.altKey && e.key === "ArrowDown" && c.openPicker()) {
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
        c.tabRunRef.current = null;
        move(d[0], d[1], e.shiftKey, mod);
        return;
      }
      case "Tab":
        e.preventDefault();
        if (!e.shiftKey && c.tabRunRef.current === null) c.tabRunRef.current = S.current.sel.anchor.col;
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
      // ⌘⇧H: find and replace, as in Google Sheets.
      if (k === "h" && e.shiftKey) {
        e.preventDefault();
        setFindOpen("replace");
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
        if (rect.r1 > rect.r0) apply(fillOps(model, activeTabId, { ...rect, r1: rect.r0 }, rect), { claim: true });
      } else if (k === "r" && !readOnly && !e.shiftKey) {
        e.preventDefault();
        if (rect.c1 > rect.c0) apply(fillOps(model, activeTabId, { ...rect, c1: rect.c0 }, rect), { claim: true });
      }
      return;
    }
    if (e.key === " " && e.shiftKey) {
      e.preventDefault();
      select({ anchor: { col: 1, row: rect.r0 }, focus: { col: 18_278, row: rect.r1 } }, { reveal: false });
    }
}
