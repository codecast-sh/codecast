// Board keyboard: single-key tools, delete, undo/redo, copy/cut/paste,
// duplicate, select all, group, z-order, nudge, zoom and fit. Keys typed
// into any field (inline edit, a prompt, the shell's inputs) are left alone.
import { useRef } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { TOOL_KEYS } from "./BoardToolbar";
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
  readOnly: boolean;
};

function typingInto(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function useBoardKeys(cmds: KeyCommands, spaceHeld: React.MutableRefObject<boolean>, rootRef: React.RefObject<HTMLDivElement | null>) {
  const ref = useRef(cmds);
  ref.current = cmds;
  // The board owns the keyboard (and paste) from the moment it opens until a
  // press lands outside it (another pane, the sidebar), and again when pressed.
  const active = useRef(true);
  useWatchEffect(() => {
    const onPress = (e: PointerEvent) => {
      const root = rootRef.current;
      active.current = !!root && root.contains(e.target as Node);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!active.current || typingInto(e.target) || e.defaultPrevented) return;
      // Only when the board is on screen and no dialog sits over it.
      const root = rootRef.current;
      if (!root || !root.isConnected || document.querySelector("[role=dialog][data-state=open]")) return;
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
      if (e.key === "Escape") { if (c.clearSelection()) stop(); c.setTool("select"); return; }
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
