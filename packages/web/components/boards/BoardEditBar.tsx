// The format bar over the text being edited: bold, italic, strike, list and
// link, the same marks Cmd+B / Cmd+I / Cmd+K type. Its buttons never take
// focus, so the caret stays in the text.
import { memo } from "react";
import { Bold, Italic, Link, List, Strikethrough } from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { formatKey, toggleList } from "./boardMarks";

const I = { size: 15, strokeWidth: 1.75 } as const;

function apply(edit: (v: string, a: number, b: number) => { value: string; start: number; end: number } | null) {
  const t = document.activeElement;
  if (!(t instanceof HTMLTextAreaElement) || !t.classList.contains("board-edit")) return;
  const r = edit(t.value, t.selectionStart, t.selectionEnd);
  if (!r) return;
  t.value = r.value;
  t.setSelectionRange(r.start, r.end);
  // The editor listens for input: the board writes what changed, the same path as typing.
  t.dispatchEvent(new Event("input", { bubbles: true }));
}

const key = (k: string, shiftKey = false) => (v: string, a: number, b: number) => formatKey({ key: k, metaKey: true, ctrlKey: false, shiftKey }, v, a, b);

export const BoardEditBar = memo(function BoardEditBar({ at }: { at: { x: number; y: number } }) {
  const btn = (label: string, accel: string | undefined, run: () => void, icon: React.ReactNode) => (
    <ShortcutTooltip label={label} accel={accel} side="top">
      <button type="button" className="board-bar-btn" aria-label={label} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={run}>{icon}</button>
    </ShortcutTooltip>
  );
  return (
    <div className="board-bar" data-board-ui style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      {btn("Bold", "CmdOrCtrl+B", () => apply(key("b")), <Bold {...I} />)}
      {btn("Italic", "CmdOrCtrl+I", () => apply(key("i")), <Italic {...I} />)}
      {btn("Strikethrough", "Shift+CmdOrCtrl+X", () => apply(key("x", true)), <Strikethrough {...I} />)}
      {btn("List", undefined, () => apply(toggleList), <List {...I} />)}
      {btn("Link", "CmdOrCtrl+K", () => apply(key("k")), <Link {...I} />)}
    </div>
  );
});
