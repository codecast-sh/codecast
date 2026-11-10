import type { QuerySuggestion } from "../lib/sessionQuerySuggestions";
import { KeyCap } from "./KeyboardShortcutsHelp";

/** One completion as it reads in any list: the operator dim, the value in
 *  full, the one-line hint trailing. The palette renders it inside its own
 *  cmdk rows; the /search box inside SessionQuerySuggestList. */
export function SessionQuerySuggestionRow({ s }: { s: QuerySuggestion }) {
  const colon = s.text.indexOf(":");
  const op = s.text.slice(0, colon + 1);
  const value = s.text.slice(colon + 1);
  return (
    <>
      <span className={`font-mono text-[12.5px] flex min-w-0 ${s.hint ? "max-w-[70%] flex-shrink-0" : "flex-1"}`}>
        <span className={`flex-shrink-0 ${value ? "text-sol-text-dim" : "text-sol-text"}`}>{op}</span>
        {/* A path loses its head, not its file name, when the row is too narrow. */}
        {value && (
          <span className={`truncate min-w-0 text-sol-text ${op === "file:" ? "[direction:rtl] text-left" : ""}`}>
            <bdi dir="ltr">{value}</bdi>
          </span>
        )}
      </span>
      {s.hint && <span className="pl-3 text-[11px] text-sol-text-dim truncate min-w-0 flex-1">{s.hint}</span>}
    </>
  );
}

/** The dropdown under the /search input. Keyboard handling stays with the
 *  input (focus never leaves it); this only draws and takes pointer picks. */
export function SessionQuerySuggestList({
  suggestions,
  selected,
  onPick,
  onHover,
  className = "z-30",
}: {
  suggestions: QuerySuggestion[];
  selected: number;
  onPick: (s: QuerySuggestion) => void;
  onHover: (index: number) => void;
  /** Stacking, for hosts whose own panels sit above z-30. */
  className?: string;
}) {
  return (
    <div
      role="listbox"
      aria-label="Filter suggestions"
      className={`absolute left-0 right-0 top-full mt-1.5 ${className} rounded-xl border border-sol-border/70 bg-sol-bg shadow-xl shadow-black/20 py-1 overflow-hidden`}
    >
      {suggestions.map((s, i) => (
        <button
          key={s.text}
          type="button"
          role="option"
          aria-selected={i === selected}
          // Keep focus (and the caret) in the input.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(s)}
          onMouseEnter={() => onHover(i)}
          className={`w-full text-left px-4 py-1.5 flex items-baseline gap-2 ${i === selected ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"}`}
        >
          <SessionQuerySuggestionRow s={s} />
        </button>
      ))}
      <div className="px-4 pt-1.5 pb-1 mt-1 border-t border-sol-border/40 flex items-center gap-1.5 text-[10px] text-sol-text-dim">
        <KeyCap size="xs">Tab</KeyCap> complete
        <KeyCap size="xs">↑</KeyCap>
        <KeyCap size="xs">↓</KeyCap> choose
      </div>
    </div>
  );
}
