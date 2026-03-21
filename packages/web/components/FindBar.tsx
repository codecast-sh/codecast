import { useState, useRef, useCallback } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useShortcutAction } from "../shortcuts";
import { X, ChevronUp, ChevronDown } from "lucide-react";

const HIGHLIGHT_NAME = "find-results";
const HIGHLIGHT_ACTIVE = "find-active";

function injectHighlightStyles() {
  if (document.getElementById("find-bar-styles")) return;
  const style = document.createElement("style");
  style.id = "find-bar-styles";
  style.textContent = `
    ::highlight(${HIGHLIGHT_NAME}) { background-color: #facc15; color: black; }
    ::highlight(${HIGHLIGHT_ACTIVE}) { background-color: #f97316; color: white; }
  `;
  document.head.appendChild(style);
}

function findTextRanges(query: string): Range[] {
  if (!query) return [];
  const ranges: Range[] = [];
  const lower = query.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.textContent?.toLowerCase() || "";
    let idx = 0;
    while ((idx = text.indexOf(lower, idx)) !== -1) {
      const range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + query.length);
      ranges.push(range);
      idx += query.length;
    }
  }
  return ranges;
}

export function FindBar() {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  useMountEffect(() => {
    injectHighlightStyles();
  });

  const clearHighlights = useCallback(() => {
    (CSS as any).highlights?.delete(HIGHLIGHT_NAME);
    (CSS as any).highlights?.delete(HIGHLIGHT_ACTIVE);
    rangesRef.current = [];
    setMatchCount(0);
    setActiveIndex(-1);
  }, []);

  const highlightAll = useCallback((text: string) => {
    clearHighlights();
    if (!text || !(CSS as any).highlights) return;
    const ranges = findTextRanges(text);
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    if (ranges.length > 0) {
      (CSS as any).highlights.set(HIGHLIGHT_NAME, new (window as any).Highlight(...ranges));
      setActiveIndex(0);
      (CSS as any).highlights.set(HIGHLIGHT_ACTIVE, new (window as any).Highlight(ranges[0]));
      const rect = ranges[0].getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        ranges[0].startContainer.parentElement?.scrollIntoView({ block: "center" });
      }
    }
  }, [clearHighlights]);

  const goToMatch = useCallback((delta: number) => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const next = (activeIndex + delta + ranges.length) % ranges.length;
    setActiveIndex(next);
    (CSS as any).highlights?.set(HIGHLIGHT_ACTIVE, new (window as any).Highlight(ranges[next]));
    const rect = ranges[next].getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      ranges[next].startContainer.parentElement?.scrollIntoView({ block: "center" });
    }
  }, [activeIndex]);

  const close = useCallback(() => {
    setVisible(false);
    setQuery("");
    clearHighlights();
  }, [clearHighlights]);

  useShortcutAction('find.toggle', useCallback(() => {
    if (visible) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setVisible(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [visible]));

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!visible) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  if (!visible) return null;

  return (
    <div className="fixed top-0 right-4 z-[200] flex items-center gap-1.5 bg-sol-bg border border-sol-border rounded-b-lg px-3 py-1.5 shadow-lg">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          highlightAll(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            goToMatch(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder="Find in page..."
        className="bg-transparent border-none outline-none text-sol-text text-sm w-48 placeholder:text-sol-text-muted"
      />
      {matchCount > 0 && (
        <span className="text-xs text-sol-text-muted whitespace-nowrap">
          {activeIndex + 1}/{matchCount}
        </span>
      )}
      {query && matchCount === 0 && (
        <span className="text-xs text-red-400 whitespace-nowrap">No matches</span>
      )}
      <button onClick={() => goToMatch(-1)} className="p-0.5 text-sol-text-muted hover:text-sol-text">
        <ChevronUp className="w-4 h-4" />
      </button>
      <button onClick={() => goToMatch(1)} className="p-0.5 text-sol-text-muted hover:text-sol-text">
        <ChevronDown className="w-4 h-4" />
      </button>
      <button onClick={close} className="p-0.5 text-sol-text-muted hover:text-sol-text">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
