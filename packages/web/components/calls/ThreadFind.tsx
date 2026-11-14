// Find in a call's thread: the field in the thread's header. The finding,
// counting and stepping live in hooks/useThreadFind.

import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

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
