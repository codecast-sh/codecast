// Find in note (Cmd+F while the vault tab is visible): highlights every match
// inside the rendered note and steps through them. Deliberately DOM-based
// rather than content-based — the reading view is HTML by the time you want to
// search it, and highlighting the live nodes keeps callouts, tables, and embeds
// searchable exactly as they appear.

import { memo, useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { KeyCap } from "../KeyboardShortcutsHelp";

const HIGHLIGHT = "vault-find-hit";
const CURRENT = "vault-find-current";

/** Wrap every occurrence of `needle` in the note's text nodes. Returns the
 *  created marks in document order. Case-insensitive, literal (not regex) —
 *  a find bar that silently interprets `.` as "any character" is a trap. */
function markMatches(root: HTMLElement, needle: string): HTMLElement[] {
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lower)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(`.${HIGHLIGHT}`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  const marks: HTMLElement[] = [];
  for (const text of targets) {
    const value = text.nodeValue ?? "";
    let cursor = 0;
    let idx = value.toLowerCase().indexOf(lower);
    if (idx === -1) continue;
    const frag = document.createDocumentFragment();
    while (idx !== -1) {
      if (idx > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, idx)));
      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT;
      mark.textContent = value.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      marks.push(mark);
      cursor = idx + needle.length;
      idx = value.toLowerCase().indexOf(lower, cursor);
    }
    if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
    text.parentNode?.replaceChild(frag, text);
  }
  return marks;
}

/** Undo markMatches: unwrap the marks and re-join the split text nodes so a
 *  later search sees whole words again. */
function clearMarks(root: HTMLElement) {
  const marks = [...root.querySelectorAll(`.${HIGHLIGHT}`)];
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
}

export const VaultFindBar = memo(function VaultFindBar({
  scopeSelector = "[data-vault-note-scroll]",
  onClose,
}: {
  scopeSelector?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const marksRef = useRef<HTMLElement[]>([]);

  const focusMatch = useCallback((index: number) => {
    const marks = marksRef.current;
    if (!marks.length) return;
    const wrapped = ((index % marks.length) + marks.length) % marks.length;
    marks.forEach((m) => m.classList.remove(CURRENT));
    const el = marks[wrapped];
    el.classList.add(CURRENT);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setCurrent(wrapped);
  }, []);

  // Re-run the search whenever the query changes; clear on unmount so the note
  // never keeps stale <mark> wrappers.
  useWatchEffect(() => {
    const root = document.querySelector(scopeSelector) as HTMLElement | null;
    if (!root) return;
    clearMarks(root);
    const marks = markMatches(root, query.trim());
    marksRef.current = marks;
    setCount(marks.length);
    if (marks.length) focusMatch(0);
    else setCurrent(0);
    return () => clearMarks(root);
  }, [query, scopeSelector, focusMatch]);

  useWatchEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  return (
    <div
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-md border border-sol-border/50 bg-sol-card shadow-lg px-2 py-1"
      data-owns-keys
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            focusMatch(current + (e.shiftKey ? -1 : 1));
          }
        }}
        placeholder="Find in note"
        spellCheck={false}
        className="w-44 bg-transparent text-[12px] text-sol-text placeholder:text-sol-text-dim outline-none"
      />
      <span className="text-[10px] text-sol-text-dim tabular-nums w-12 text-right">
        {count ? `${current + 1}/${count}` : query ? "0/0" : ""}
      </span>
      <button
        type="button"
        onClick={() => focusMatch(current - 1)}
        className="text-sol-text-dim hover:text-sol-text disabled:opacity-30"
        disabled={!count}
        aria-label="Previous match"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => focusMatch(current + 1)}
        className="text-sol-text-dim hover:text-sol-text disabled:opacity-30"
        disabled={!count}
        aria-label="Next match"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <span className="text-[10px] text-sol-text-dim ml-0.5">
        <KeyCap size="xs">esc</KeyCap>
      </span>
      <button type="button" onClick={onClose} className="text-sol-text-dim hover:text-sol-text" aria-label="Close find">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});
