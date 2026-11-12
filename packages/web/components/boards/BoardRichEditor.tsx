// In-place editing for stickies, text and shapes: formatting shows as
// formatting while you type (bold is bold, a link is a link, a list has
// bullets), the way FigJam edits. The board stores the same marks it always
// did (**bold**, [text](url), "- " lines), so agents, exports and the canvas
// read one format. The editor is uncontrolled: React never rewrites what is
// being typed, and each keystroke costs one serialize and one preview write.
import { useLayoutEffect, useRef } from "react";
import { editorToMarks, marksToHtml } from "./boardMarks";
import { applyFormat, formatForKey, LINK_REQUEST, type FormatCommand } from "./boardEditCommands";
import { claimKeys } from "../../shortcuts/keyOwnership";
import { useMountEffect } from "../../hooks/useMountEffect";

export function RichEditor({ value, className, style, onInput, onDone, onNext }: {
  value: string;
  className: string;
  style?: React.CSSProperties;
  onInput(text: string): void;
  onDone(): void;
  onNext?(dir: 1 | -1): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = marksToHtml(value);
    el.focus({ preventScroll: true });
    // The caret starts at the end, ready to add to what is there.
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    // Mount-only: the editor owns its content from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const emit = () => {
    const ed = ref.current;
    if (!ed) return;
    // "- " or "* " typed at the start of a line becomes a bullet, as in any list editor.
    const sel = document.getSelection();
    const node = sel?.anchorNode;
    if (node && node.nodeType === 3 && /^[-*][ \u00a0]$/.test((node.textContent ?? "").slice(0, 2)) && sel!.anchorOffset === 2 && isLineStart(ed, node)) {
      node.textContent = `• ${(node.textContent ?? "").slice(2)}`;
      const r = document.createRange();
      r.setStart(node, 2);
      r.collapse(true);
      sel!.removeAllRanges();
      sel!.addRange(r);
    }
    onInput(editorToMarks(ed));
  };
  const format = (f: FormatCommand) => {
    if (f === "link") {
      window.dispatchEvent(new Event(LINK_REQUEST));
      return;
    }
    applyFormat(f);
  };
  // The format keys belong to the text while it is being edited: claimed in the app's first key
  // listener, so Cmd+K links instead of opening the command palette, and Cmd+B never reaches a shortcut.
  useMountEffect(() => claimKeys((e) => {
    if (document.activeElement !== ref.current) return false;
    const f = formatForKey(e);
    if (!f) return false;
    e.preventDefault();
    format(f);
    return true;
  }));
  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      className={`board-edit board-rich-edit ${className}`}
      style={style}
      onInput={emit}
      // The format bar's link field takes focus for a moment; that is not the end of editing.
      onBlur={(e) => { if (!(e.relatedTarget as HTMLElement | null)?.closest?.("[data-board-editbar]")) onDone(); }}
      onPointerDown={(e) => e.stopPropagation()}
      // Pasting brings words, not another page's styling.
      onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const f = formatForKey(e);
        if (f) {
          e.preventDefault();
          format(f);
          return;
        }
        if (e.key === "Tab" && onNext) {
          e.preventDefault();
          onNext(e.shiftKey ? -1 : 1);
          return;
        }
        // Enter on a bulleted line starts the next bullet, as in any list editor.
        if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
          const line = lineText();
          if (line.startsWith("• ")) {
            e.preventDefault();
            if (line.trim() === "•") { applyFormat("list"); return; }
            document.execCommand("insertParagraph");
            document.execCommand("insertText", false, "• ");
            return;
          }
        }
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );

  function lineText(): string {
    const ed = ref.current;
    let n: Node | null = document.getSelection()?.anchorNode ?? null;
    while (n && n.parentNode !== ed) n = n.parentNode;
    return n?.textContent ?? "";
  }
}

/** Whether a text node starts its line in the editor (first text of a top-level line). */
function isLineStart(editor: HTMLElement, node: Node): boolean {
  let n: Node = node;
  while (n.parentNode && n.parentNode !== editor) {
    if (n.parentNode.firstChild !== n) return false;
    n = n.parentNode;
  }
  if (n.parentNode !== editor) return false;
  // A loose text node at the top is a line only when it opens the editor or follows a block.
  const prev = n.previousSibling;
  return n.nodeType === 1 || !prev || (prev.nodeType === 1 && ["DIV", "P", "BR"].includes((prev as Element).tagName));
}
