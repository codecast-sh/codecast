import { useLayoutEffect, useRef } from "react";
import type { MentionItem } from "../../lib/mentionItem";
import { groupMentionItems } from "../../lib/mentionRanking";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { MentionDetail, MentionSuggestion } from "./MentionSuggestion";

type MenuItem = Omit<MentionItem, "id"> & { id?: string; description?: string };

// The one suggestion popup every composer draws: the conversation and chat
// composers (MessageInput) and the doc editor (MentionList). Callers own the
// items, the selection and the keys; this owns the look.
//
// `items` must already be in orderMentionItems order, so a selected index
// names the same row here as in the caller's key handler.
export function MentionMenu({
  items, selectedIndex, onHover, onPick, query, loading, contextTitle, heading, className, style,
}: {
  items: MenuItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  query?: string;
  /** A server search is still out: the list may grow. */
  loading?: boolean;
  /** Section title for what the conversation already names. */
  contextTitle?: string;
  /** A single title for a list that is not grouped by kind (commands). */
  heading?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the selected row in view when the keyboard moves it, never when the
  // pointer does: scrolling under a hovering pointer re-targets the hover.
  const fromPointerRef = useRef(false);
  useLayoutEffect(() => {
    if (fromPointerRef.current) { fromPointerRef.current = false; return; }
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const groups = heading
    ? [{ key: "all", title: heading, items }]
    : groupMentionItems(items, contextTitle);
  const selected = items[selectedIndex];
  let index = 0;

  return (
    <div
      className={`bg-sol-bg border border-sol-border/60 rounded-xl shadow-2xl overflow-hidden flex flex-col ${className ?? ""}`}
      style={style}
    >
      <div ref={listRef} role="listbox" aria-label="Suggestions" className="overflow-y-auto overflow-x-hidden overscroll-contain max-h-[min(440px,52vh)] pb-1">
        {groups.map((group) => (
          <div key={group.key} role="group" aria-label={group.title}>
            <div className="sticky top-0 z-[1] px-3 pt-2 pb-1 bg-sol-bg/95 backdrop-blur-sm flex items-center gap-2 text-[11px] font-medium text-sol-text-dim">
              <span>{group.title}</span>
              <span className="h-px flex-1 bg-sol-border/40" />
            </div>
            {group.items.map((item) => {
              const i = index++;
              const active = i === selectedIndex;
              return (
                <button
                  key={`${item.type}:${item.id || item.label}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-index={i}
                  data-mention-id={item.id}
                  onMouseDown={(e) => { e.preventDefault(); onPick(i); }}
                  onMouseMove={() => { if (!active) { fromPointerRef.current = true; onHover(i); } }}
                  className={`relative w-full text-left pl-3 pr-3 h-8 flex items-center gap-2.5 transition-colors duration-75 ${active ? "bg-sol-blue/10" : "hover:bg-sol-text/[0.03]"}`}
                >
                  {active && <span aria-hidden className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r bg-sol-blue" />}
                  <MentionSuggestion item={item} query={query} />
                </button>
              );
            })}
          </div>
        ))}
        {!items.length && !loading && <div className="px-3 py-4 text-xs text-sol-text-dim text-center">No matches</div>}
      </div>
      {selected && selected.type !== "date" && (
        <div className="border-t border-sol-border/40 bg-sol-bg-alt/40">
          <MentionDetail item={selected} />
        </div>
      )}
      <div className="border-t border-sol-border/40 px-3 h-7 flex items-center gap-3 text-[10px] text-sol-text-dim">
        <span className="flex items-center gap-1"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> move</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">↵</KeyCap> insert</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> close</span>
        <span className="ml-auto flex items-center gap-1.5" role="status">
          {loading ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
              Searching everything
            </>
          ) : `${items.length} result${items.length === 1 ? "" : "s"}`}
        </span>
      </div>
    </div>
  );
}
