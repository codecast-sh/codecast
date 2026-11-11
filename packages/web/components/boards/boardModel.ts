// Board constants and pure helpers shared by the view, its toolbar and keys.
import type { BoardEl, BoardTool } from "./boardTypes";
import { isMac } from "../../shortcuts/registry";

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

const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";

/**
 * The board's keys, as sections of the app's "?" shortcuts panel (shown while
 * a board is on screen). Each row's keys are the caps it draws.
 */
export const BOARD_SHORTCUT_SECTIONS: { title: string; rows: [string, string[]][] }[] = [
  { title: "Tools", rows: [["Select", ["V"]], ["Hand", ["H"]], ["Sticky", ["S"]], ["Text", ["T"]], ["Shape", ["R"]], ["Arrow", ["L"]], ["Frame", ["F"]], ["Pen", ["P"]], ["Stamp", ["E"]], ["Comment", ["C"]], ["Codecast object", ["O"]], ["Place one (tool armed)", ["Enter"]], ["Keep tool on", ["Q"]], ["Ask agent", ["A"]]] },
  { title: "Selection", rows: [["Next / previous element", ["Tab", `${SHIFT} Tab`]], ["Edit", ["Enter"]], ["Nudge", ["←↑→↓"]], ["Nudge 10", [SHIFT, "←↑→↓"]], ["Select all", [MOD, "A"]], ["Duplicate", [MOD, "D"]], ["Group / ungroup", [MOD, "G"]], ["Front / back", ["]", "["]], ["Delete", ["⌫"]], ["Deselect", ["Esc"]]] },
  { title: "While typing", rows: [["Bold / italic", [MOD, "B / I"]], ["Link", [MOD, "K"]], ["Next sticky right / below", ["Tab", `${SHIFT} Tab`]], ["Done", ["Esc"]]] },
  { title: "View", rows: [["Zoom in / out", [MOD, "+ / −"]], ["100%", [MOD, "0"]], ["Fit everything", [SHIFT, "1"]], ["Zoom to selection", [SHIFT, "2"]], ["Pan", ["Space", "drag"]], ["Undo / redo", [`${MOD} Z`, `${SHIFT}${MOD} Z`]]] },
];

