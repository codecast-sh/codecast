// Board keyboard: single-key tools, delete, undo/redo, copy/cut/paste,
// duplicate, select all, group, z-order, nudge, zoom and fit. Keys typed
// into any field (inline edit, a prompt, the shell's inputs) are left alone.
import { useRef } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { TOOL_KEYS } from "./boardModel";
import type { BoardTool } from "./boardTypes";

export type KeyCommands = {
  setTool(t: BoardTool): void;
  deleteSelection(): void;
  undo(): void;
  redo(): void;
  copy(cut: boolean): void;
  duplicate(): void;
  selectAll(): void;
  clearSelection(): boolean;
  group(off: boolean): void;
  order(where: "front" | "back"): void;
  nudge(dx: number, dy: number): void;
  zoomBy(f: number): void;
  zoomTo(z: number): void;
  fit(selectionOnly: boolean): void;
  editSelection(): void;
  ask(): void;
  /** Select the next (+1) or previous (-1) element in reading order; false when there is nothing to walk. */
  cycle(dir: 1 | -1): boolean;
  hasSelection(): boolean;
  toggleLock(): void;
  readOnly: boolean;
};

/** A dialog, popover or menu is open over the page: its own Escape closes it. */
function overlayOpen(): boolean {
  return !!document.querySelector("[role=dialog][data-state=open], [data-radix-popper-content-wrapper], [role=menu], [role=listbox]");
}

export function useBoardKeys(cmds: KeyCommands, spaceHeld: React.MutableRefObject<boolean>, rootRef: React.RefObject<HTMLDivElement | null>) {
  const ref = useRef(cmds);
  ref.current = cmds;
  // The board owns the keyboard (and paste) from the moment it opens until a
  // press lands outside it (another pane, the sidebar), and again when pressed.
  const active = useRef(true);
  /** Tab is walking elements (set by a walk, cleared by an Escape with nothing left to clear). */
  const walked = useRef(false);
  useWatchEffect(() => {
    const onPress = (e: PointerEvent) => {
      const root = rootRef.current;
      active.current = !!root && root.contains(e.target as Node);
    };
    const onKey = (e: KeyboardEvent) => {
      // The page's own Escape goes back to the list; on a board, a stray Escape (after a popover closed, a press in the header) must not.
      if (e.key === "Escape" && !active.current && !e.defaultPrevented && !keyBelongsElsewhere(e.target)) {
        const root = rootRef.current;
        if (root?.isConnected && !overlayOpen()) { e.preventDefault(); e.stopImmediatePropagation(); ref.current.clearSelection(); return; }
      }
      if (!active.current || keyBelongsElsewhere(e.target) || e.defaultPrevented) return;
      // Only when the board is on screen and no dialog sits over it.
      const root = rootRef.current;
      if (!root || !root.isConnected || overlayOpen()) return;
      const c = ref.current;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // Capture phase + stopImmediatePropagation: a board key never also reaches the app's global shortcuts.
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === " " && !e.repeat) {
        spaceHeld.current = true;
        root.dataset.space = "1";
        stop();
        return;
      }
      if (mod && (k === "=" || k === "+")) { stop(); c.zoomBy(1.25); return; }
      if (mod && k === "-") { stop(); c.zoomBy(0.8); return; }
      if (mod && k === "0") { stop(); c.zoomTo(1); return; }
      if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) { stop(); c.fit(false); return; }
      if (e.shiftKey && (e.key === "@" || e.code === "Digit2")) { stop(); c.fit(true); return; }
      // Escape belongs to the board while it is in use: it backs out of a menu, a selection or a tool, never out of the page.
      if (e.key === "Escape") { if (!c.clearSelection()) walked.current = false; c.setTool("select"); stop(); return; }
      // Tab walks the board's elements (with Shift, backwards). With nothing selected after an Escape, Tab moves on through the page.
      if (e.key === "Tab" && !mod && !e.altKey) {
        const inBoard = c.hasSelection() || document.activeElement === root || walked.current;
        if (inBoard && c.cycle(e.shiftKey ? -1 : 1)) { walked.current = true; stop(); return; }
        return;
      }
      // A version open in history, or a viewer without edit rights: nothing below writes.
      if (c.readOnly) return;
      if (mod && k === "z") { stop(); if (e.shiftKey) c.redo(); else c.undo(); return; }
      if (mod && k === "y") { stop(); c.redo(); return; }
      if (mod && k === "a") { stop(); c.selectAll(); return; }
      if (mod && k === "c") { c.copy(false); return; }
      if (mod && k === "x") { c.copy(true); return; }
      if (mod && k === "d") { stop(); c.duplicate(); return; }
      if (mod && k === "g") { stop(); c.group(e.shiftKey); return; }
      if (e.key === "Backspace" || e.key === "Delete") { stop(); c.deleteSelection(); return; }
      if (e.key === "]") { stop(); c.order("front"); return; }
      if (e.key === "[") { stop(); c.order("back"); return; }
      if (e.key === "Enter") { stop(); c.editSelection(); return; }
      if (e.key.startsWith("Arrow")) {
        stop();
        const step = e.shiftKey ? 10 : 1;
        c.nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
        return;
      }
      if (mod || e.altKey) return;
      if (k === "a") { stop(); c.ask(); return; }
      if (k === "q") { stop(); c.toggleLock(); return; }
      const tool = TOOL_KEYS[k];
      if (tool) { stop(); c.setTool(tool); }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === " ") {
        spaceHeld.current = false;
        const root = rootRef.current;
        if (root) delete root.dataset.space;
      }
    };
    window.addEventListener("pointerdown", onPress, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("pointerdown", onPress, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onUp);
    };
  }, []);
  return active;
}
