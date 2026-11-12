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


const isBlock = (n: Node | null) => !!n && n.nodeType === 1 && ["DIV", "P", "BR"].includes((n as Element).tagName);

/**
 * The editor's lines as the nodes each starts with. A line is a block (<div>),
 * or a run of inline nodes at the top (the first line before any block, or
 * text after a <br>).
 */
function lineStarts(editor: HTMLElement): Node[] {
  const out: Node[] = [];
  let prev: Node | null = null;
  for (const n of Array.from(editor.childNodes)) {
    if (n.nodeType === 1 && (n as Element).tagName === "BR") { prev = n; continue; }
    if (isBlock(n) || !prev || isBlock(prev)) out.push(n);
    prev = n;
  }
  return out;
}

/** The start of the line holding `node` (a top-level child of the editor). */
function lineOf(editor: HTMLElement, node: Node | null): Node | null {
  if (!node) return null;
  if (node === editor) return null;
  while (node.parentNode && node.parentNode !== editor) node = node.parentNode;
  if (isBlock(node) && (node as Element).tagName !== "BR") return node;
  while (node.previousSibling && !isBlock(node.previousSibling)) node = node.previousSibling;
  return node;
}

/**
 * Bullet every line the selection touches, or take the bullets off when all
 * of them already have one (the List button and its toggle).
 */
export function toggleBullet(editor: HTMLElement, sel: Selection | null = document.getSelection()) {
  const doc = editor.ownerDocument;
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const starts = lineStarts(editor);
  if (!starts.length) { doc.execCommand("insertText", false, "• "); return; }
  let lines = range && !range.collapsed ? starts.filter((n) => range.intersectsNode(n) || (n.nodeType === 1 && (n as Element).contains(range.startContainer))) : [];
  if (!lines.length) {
    // A caret: its line, or (the caret between lines) the line just before it.
    const at = sel?.anchorNode === editor ? editor.childNodes[Math.max(0, (sel?.anchorOffset ?? 1) - 1)] ?? null : sel?.anchorNode ?? null;
    const line = lineOf(editor, at) ?? starts[starts.length - 1];
    lines = [line];
  }
  const firsts = lines.map((n) => ({ n, t: firstText(n) }));
  const allOn = firsts.every(({ t }) => t?.textContent?.startsWith("• "));
  for (const { n, t } of firsts) {
    if (allOn) t!.textContent = t!.textContent!.slice(2);
    else if (!t?.textContent?.startsWith("• ")) {
      if (n.nodeType === 3) (n as Text).textContent = `• ${n.textContent}`;
      else if (isBlock(n)) n.insertBefore(doc.createTextNode("• "), n.firstChild);
      else n.parentNode!.insertBefore(doc.createTextNode("• "), n);
    }
  }
  editor.dispatchEvent(new (doc.defaultView ?? window).Event("input", { bubbles: true }));
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
