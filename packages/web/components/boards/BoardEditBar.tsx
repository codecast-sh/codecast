// The format bar over the text being edited: bold, italic, strike, list and
// link. Its buttons never take focus, so the caret stays in the text; the
// link button (or Cmd+K with words selected) opens an address field in the bar.
import { memo, useRef, useState } from "react";
import { Bold, Italic, Link, List, Strikethrough } from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useMountEffect } from "../../hooks/useMountEffect";
import { activeBoardEditor, applyFormat, LINK_REQUEST, type FormatCommand } from "./boardEditCommands";

const I = { size: 15, strokeWidth: 1.75 } as const;

export const BoardEditBar = memo(function BoardEditBar({ at }: { at: { x: number; y: number } }) {
  const [linking, setLinking] = useState(false);
  const saved = useRef<{ editor: HTMLElement; range: Range | null } | null>(null);
  const openLink = () => {
    const editor = activeBoardEditor();
    if (!editor) return;
    const sel = document.getSelection();
    saved.current = { editor, range: sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null };
    setLinking(true);
  };
  useMountEffect(() => {
    window.addEventListener(LINK_REQUEST, openLink);
    return () => window.removeEventListener(LINK_REQUEST, openLink);
  });
  const finishLink = (href: string | null) => {
    const s = saved.current;
    setLinking(false);
    saved.current = null;
    if (!s) return;
    s.editor.focus({ preventScroll: true });
    if (s.range) { const sel = document.getSelection(); sel?.removeAllRanges(); sel?.addRange(s.range); }
    const url = href?.trim();
    if (url) applyFormat("link", /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url}`);
  };
  const run = (cmd: FormatCommand) => { if (applyFormat(cmd) === "need-link") openLink(); };
  const btn = (label: string, accel: string | undefined, cmd: FormatCommand, icon: React.ReactNode) => (
    <ShortcutTooltip label={label} accel={accel} side="top">
      <button type="button" className="board-bar-btn" aria-label={label} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => run(cmd)}>{icon}</button>
    </ShortcutTooltip>
  );
  return (
    <div className="board-bar" data-board-ui data-board-editbar style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      {linking ? (
        <input
          autoFocus
          className="board-bar-link"
          placeholder="Paste a link"
          aria-label="Link address"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); finishLink(e.currentTarget.value); }
            if (e.key === "Escape") { e.preventDefault(); finishLink(null); }
          }}
          onBlur={(e) => finishLink(e.currentTarget.value)}
        />
      ) : (
        <>
          {btn("Bold", "CmdOrCtrl+B", "bold", <Bold {...I} />)}
          {btn("Italic", "CmdOrCtrl+I", "italic", <Italic {...I} />)}
          {btn("Strikethrough", "Shift+CmdOrCtrl+X", "strike", <Strikethrough {...I} />)}
          {btn("List", undefined, "list", <List {...I} />)}
          {btn("Link", "CmdOrCtrl+K", "link", <Link {...I} />)}
        </>
      )}
    </div>
  );
});
