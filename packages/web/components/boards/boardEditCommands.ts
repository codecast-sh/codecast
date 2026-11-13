// What the format keys and the format bar do to the text being edited in
// place. The rich editor (a contenteditable) takes the browser's own
// formatting commands, so the selection, the caret and undo inside the editor
// behave as in any text field; the plain editor (frame titles, arrow labels)
// takes the marks as text.
import { editorToMarks, formatKey, marksToHtml, toggleList } from "./boardMarks";

export type FormatCommand = "bold" | "italic" | "strike" | "list" | "link";

/** The editor holding focus, if it is one of the board's. */
export function activeBoardEditor(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a?.classList.contains("board-edit") ? a : null;
}


/**
 * A selection end between nodes (the whole editor selected, a caret between
 * lines) moved down into the nearest text, so a mark placed there lands inside
 * a line rather than becoming a line of its own.
 */
function intoText(node: Node, offset: number, atEnd: boolean): [Node, number] {
  const len = (n: Node) => (n.nodeType === 3 ? (n.textContent ?? "").length : n.childNodes.length);
  while (node.nodeType === 1 && node.childNodes.length) {
    const kids = node.childNodes;
    // The start goes to the beginning of the node after it; the end to the close of the node before it.
    if (atEnd) { const c = kids[offset > 0 ? offset - 1 : 0]; node = c; offset = offset > 0 ? len(c) : 0; }
    else { const c = kids[Math.min(offset, kids.length - 1)]; node = c; offset = offset < kids.length ? 0 : len(c); }
  }
  return [node, offset];
}

/**
 * Bullet the lines the selection touches, or take the bullets off when all of
 * them already have one. Works on the stored text (the same marks the board
 * saves): the selection's ends are marked in place, the editor is read back
 * as text, the lines between the marks toggle their "- ", and the editor is
 * drawn again from the result. A line is a line however it was made (Enter or
 * Shift+Enter).
 */
export function toggleBullet(editor: HTMLElement, sel: Selection | null = document.getSelection()) {
  const doc = editor.ownerDocument;
  const START = "\uE000", END = "\uE001";
  const range = sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : null;
  if (range) {
    const e = doc.createRange(); const [ec, eo] = intoText(range.endContainer, range.endOffset, true); e.setStart(ec, eo); e.insertNode(doc.createTextNode(END));
    const b = doc.createRange(); const [bc, bo] = intoText(range.startContainer, range.startOffset, false); b.setStart(bc, bo); b.insertNode(doc.createTextNode(START));
  }
  // A mark placed before a line's bullet hides the bullet from the reader: list lines are read here too.
  const marked = editorToMarks(editor).replace(/^([\uE000\uE001]*)• /gm, "$1- ");
  const at = marked.indexOf(START);
  const text = marked.split(START).join("").split(END).join("");
  const a = at >= 0 ? at : text.length;
  const z = range ? marked.split(START).join("").indexOf(END) : text.length;
  const r = toggleList(text, a, Math.max(a, z));
  editor.innerHTML = marksToHtml(r.value);
  // The caret goes to the end of the last line that changed.
  const lastLine = r.value.slice(0, r.end).split("\n").length - 1;
  const block = editor.children[lastLine] ?? editor.lastElementChild;
  if (block && sel) {
    const c = doc.createRange();
    c.selectNodeContents(block);
    c.collapse(false);
    sel.removeAllRanges();
    sel.addRange(c);
  }
  editor.dispatchEvent(new (doc.defaultView ?? window).Event("input", { bubbles: true }));
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
    // With words selected they become the link; with none, the address goes in as its own link.
    if (document.getSelection()?.isCollapsed) {
      const shown = href.replace(/^https?:\/\//, "").replace(/\/$/, "");
      document.execCommand("insertHTML", false, `<a href="${href.replace(/"/g, "&quot;")}">${shown.replace(/</g, "&lt;")}</a>&nbsp;`);
    } else document.execCommand("createLink", false, href);
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
