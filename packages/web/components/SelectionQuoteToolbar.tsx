// Floating toolbar that appears when the user selects text inside an assistant
// message body (anything inside a .cc-msg-review region). One action — "Quote
// into reply" — which adds the selection to your reply as a rail card with an
// optional note (same single verb as the per-block hover handle). Positioned at
// the selection rect via a portal.
//
// The same action has a key: `r` (conv.review). The button carries its keycap, so
// the shortcut is learned from the place you already use. Resolving the selection
// lives in lib/quoteSelection so the button and the key quote the same thing.

import React, { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveQuoteSelection, quoteSelectionIntoReply, type QuoteSelection } from "../lib/quoteSelection";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { FilePathContext, filePathHref, filePathMention } from "../lib/filePathLinks";
import { openFiles } from "../lib/filesPane";

// A selection that names a file the auto-linker left alone (`packages/web`,
// a bare `page.tsx`, a path in a code block): any single token with a slash
// or an extension. Selecting it is the intent; the strict grammar that keeps
// prose clean does not apply here.
function selectedPath(quote: string): { path: string; line?: number } | null {
  const text = quote.trim();
  if (!text || /\s/.test(text)) return null;
  const mention = filePathMention(text);
  if (mention) return { path: mention.path, line: mention.line };
  if (text.includes("/") || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(text)) return { path: text.replace(/[.,;:!?)]+$/, "") };
  return null;
}

export function SelectionQuoteToolbar({ conversationId }: { conversationId: string }) {
  const [anchor, setAnchor] = useState<QuoteSelection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAnchor(resolveQuoteSelection()), 120);
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        if (timer.current) clearTimeout(timer.current);
        setAnchor(null);
      } else {
        schedule();
      }
    };
    const onMouseUp = () => schedule();
    const onScroll = () => setAnchor(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnchor(null);
    };

    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const fileCtx = useContext(FilePathContext);
  if (!anchor) return null;

  // Same single verb as the per-block handle and the `r` key: quote the selection
  // into your reply as a rail card, with an optional note.
  const doQuote = () => {
    quoteSelectionIntoReply(conversationId);
    setAnchor(null);
  };
  const asPath = selectedPath(anchor.quote);
  const doOpenFile = () => {
    if (!asPath) return;
    openFiles(filePathHref(asPath.path, asPath.line, fileCtx));
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };

  // Place above the selection; flip below if too close to the top.
  const flipBelow = anchor.y < 56;
  return createPortal(
    <div
      className="cc-sel-toolbar"
      style={{
        left: anchor.x,
        top: flipBelow ? anchor.y + 22 : anchor.y - 8,
        transform: flipBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="cc-sel-btn" onClick={doQuote}>
        ❝ Quote into reply
        <KeyCap size="xs">R</KeyCap>
      </button>
      {asPath && (
        <button type="button" className="cc-sel-btn" onClick={doOpenFile} title={`Open ${asPath.path} in Files`}>
          Open in Files
        </button>
      )}
    </div>,
    document.body,
  );
}
