// What the format keys and the format bar do to the text being edited in
// place. The rich editor (a contenteditable) takes the browser's own
// formatting commands, so the selection, the caret and undo inside the editor
// behave as in any text field; the plain editor (frame titles, arrow labels)
// takes the marks as text.
import { formatKey, toggleList } from "./boardMarks";

export type FormatCommand = "bold" | "italic" | "strike" | "list" | "link";

/** The editor holding focus, if it is one of the board's. */
export function activeBoardEditor(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a?.classList.contains("board-edit") ? a : null;
}

/** The line (block) of a rich editor the caret is in. */
function caretBlock(editor: HTMLElement): HTMLElement | null {
  const sel = document.getSelection();
  let n: Node | null = sel?.anchorNode ?? null;
  while (n && n.parentNode !== editor) n = n.parentNode;
  return n && n.nodeType === 1 ? (n as HTMLElement) : null;
}

/** Bullet the caret's line, or take the bullet off. */
function toggleBullet(editor: HTMLElement) {
  const block = caretBlock(editor);
  const first = block ? firstText(block) : null;
  if (first && first.textContent?.startsWith("• ")) first.textContent = first.textContent.slice(2);
  else if (block) block.insertBefore(document.createTextNode("• "), block.firstChild);
  else document.execCommand("insertText", false, "• ");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function firstText(n: Node): Text | null {
  if (n.nodeType === 3) return n as Text;
  for (const c of Array.from(n.childNodes)) { const t = firstText(c); if (t) return t; }
  return null;
}

/**
 * Apply a format to the focused editor. `link` takes the address; with no
 * address it asks the caller to open its link field (returns "need-link").
 */
export function applyFormat(cmd: FormatCommand, href?: string): "done" | "need-link" | "no-editor" {
  const ed = activeBoardEditor();
  if (!ed) return "no-editor";
  if (ed instanceof HTMLTextAreaElement) {
    const r = cmd === "list"
      ? toggleList(ed.value, ed.selectionStart, ed.selectionEnd)
      : formatKey({ key: cmd === "bold" ? "b" : cmd === "italic" ? "i" : cmd === "strike" ? "x" : "k", metaKey: true, ctrlKey: false, shiftKey: cmd === "strike" }, ed.value, ed.selectionStart, ed.selectionEnd);
    if (!r) return "done";
    ed.value = r.value;
    ed.setSelectionRange(r.start, r.end);
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    return "done";
  }
  if (cmd === "list") { toggleBullet(ed); return "done"; }
  if (cmd === "link") {
    if (!href) return "need-link";
    document.execCommand("createLink", false, href);
    return "done";
  }
  document.execCommand(cmd === "bold" ? "bold" : cmd === "italic" ? "italic" : "strikeThrough");
  return "done";
}

/** The format a key press asks for (Cmd+B / Cmd+I / Cmd+Shift+X / Cmd+K), if any. */
export function formatForKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): FormatCommand | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (k === "b") return "bold";
  if (k === "i") return "italic";
  if (k === "x" && e.shiftKey) return "strike";
  if (k === "k") return "link";
  return null;
}

/** Ask the format bar to open its link field (Cmd+K with text selected). */
export const LINK_REQUEST = "board-edit-link";
