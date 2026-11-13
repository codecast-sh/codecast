// Find in a call's thread: a field in the thread's header that highlights
// every match in what was said and typed, counts them, and steps through
// them. The thread unfolds the passages that hold a match (it reads
// `passageHits`), and the highlights paint through the CSS Highlight API
// (lib/textFind), so the words keep streaming in under them on a live call.

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { findTextRanges, setHighlight } from "../../lib/textFind";
import { scrollIntoContainer } from "../../lib/scrollWithin";
import type { Passage } from "./roomThreadModel";

const HIT = "rt-find-hit";
const CURRENT = "rt-find-current";
/** The text a match may sit in: a spoken line, or a typed or agent line's
 *  body. Names, clocks and fold previews are chrome. */
const SEARCHED = "[data-seq], .rt-line-body";

/** The passages whose words hold `query`: the thread opens these. */
export function passageHits(passages: Passage[], query: string): Set<number> {
  const q = query.trim().toLowerCase();
  const out = new Set<number>();
  if (!q) return out;
  for (const p of passages) if (p.segments.some((s) => s.text.toLowerCase().includes(q))) out.add(p.index);
  return out;
}

/** Runs after every render of the thread while a query stands, so a word
 *  that lands mid-search is found too. Returns the count, the current hit
 *  and a stepper. `onJump` hears each move the find makes (the thread stops
 *  following the tail). */
export function useThreadFind(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  query: string,
  onJump: () => void,
): { count: number; current: number; step: (delta: number) => void } {
  const q = query.trim();
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(0);
  const placedForRef = useRef("");

  const show = (index: number, scroll: boolean) => {
    const ranges = rangesRef.current;
    currentRef.current = index;
    setCurrent(index);
    setHighlight(CURRENT, ranges[index] ? [ranges[index]] : []);
    const el = ranges[index]?.startContainer.parentElement;
    if (!scroll || !el) return;
    onJump();
    scrollIntoContainer(el, { block: "center" });
    // A passage the find just unfolded grows for 200ms; land again once it
    // has its height.
    setTimeout(() => {
      if (currentRef.current === index && el.isConnected) scrollIntoContainer(el, { block: "center" });
    }, 230);
  };

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!q || !root) {
      rangesRef.current = [];
      placedForRef.current = "";
      setHighlight(HIT, []);
      setHighlight(CURRENT, []);
      setCount(0);
      return;
    }
    const ranges = findTextRanges(root, q, (n) => !!n.parentElement?.closest(SEARCHED));
    rangesRef.current = ranges;
    setCount(ranges.length);
    setHighlight(HIT, ranges);
    if (placedForRef.current !== q) {
      // A new query starts at the first match in view or below it, the way
      // a browser's find does; one with nothing below wraps to the first.
      placedForRef.current = q;
      const top = root.getBoundingClientRect().top;
      const below = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top);
      show(Math.max(0, below), ranges.length > 0);
    } else {
      // The same query over new words: the current hit stays put.
      show(Math.min(currentRef.current, Math.max(0, ranges.length - 1)), false);
    }
  });

  useLayoutEffect(
    () => () => {
      setHighlight(HIT, []);
      setHighlight(CURRENT, []);
    },
    [],
  );

  const step = (delta: number) => {
    const n = rangesRef.current.length;
    if (n) show((currentRef.current + delta + n) % n, true);
  };
  return { count, current, step };
}

export function ThreadFindField({
  query,
  onQuery,
  count,
  current,
  step,
  inputRef,
}: {
  query: string;
  onQuery: (q: string) => void;
  count: number;
  current: number;
  step: (delta: number) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const q = query.trim();
  return (
    <span className="rt-find" data-filled={query ? "" : undefined} role="search">
      <Search className="rt-find-icon h-3 w-3" aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (query) onQuery("");
            else e.currentTarget.blur();
          }
        }}
        placeholder="Find"
        aria-label="Find in this call"
        spellCheck={false}
        autoComplete="off"
        className="rt-find-input"
      />
      {q && (
        <>
          <span className={`rt-find-count${count ? "" : " rt-find-none"}`} aria-live="polite">
            {count ? `${current + 1}/${count}` : "0/0"}
          </span>
          <button type="button" className="rt-find-btn" onClick={() => step(-1)} disabled={!count} aria-label="Previous match" title="Previous match">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="rt-find-btn" onClick={() => step(1)} disabled={!count} aria-label="Next match" title="Next match">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {query && (
        <button
          type="button"
          className="rt-find-btn"
          onClick={() => {
            onQuery("");
            inputRef.current?.focus();
          }}
          aria-label="Clear find"
          title="Clear"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
