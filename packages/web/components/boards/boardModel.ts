// Board constants and pure helpers shared by the view, its toolbar and keys.
import type { BoardEl, BoardTool } from "./boardTypes";

/** The single-key shortcut for each tool. */
export const TOOL_KEYS: Record<string, BoardTool> = {
  v: "select", h: "hand", t: "text", f: "frame", s: "sticky", p: "pen", r: "shape", l: "connector", e: "stamp", c: "comment", o: "card",
};

/** The field an element's inline edit writes. */
export function editField(el: BoardEl): "text" | "title" | "label" | null {
  if (el.kind === "sticky" || el.kind === "text" || el.kind === "shape") return "text";
  if (el.kind === "frame") return "title";
  if (el.kind === "connector") return "label";
  return null;
}

/** The board's Ask draft (toolbar Ask and Describe a change share it). */
export const BOARD_ASK_SLOT = "board-ask";
