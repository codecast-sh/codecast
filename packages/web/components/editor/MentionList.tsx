import { forwardRef, useImperativeHandle, useState, useCallback, useRef, useMemo } from "react";
import { useMentionServerSearch, useActiveMentionScope, SERVER_MENTION_TYPES } from "../../hooks/useMentionQuery";
import { mergeMentionSuggestions, mentionViewTimes } from "../../lib/mentionRanking";
import { useInboxStore } from "../../store/inboxStore";
import { MentionSuggestion } from "./MentionSuggestion";

export type MentionItem = {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  /** The @handle this person answers to in team chat — the server's mention
   *  vocabulary (github username, email local part, or a bot's name slug). */
  handle?: string;
  isBot?: boolean;
  image?: string;
  shortId?: string;
  status?: string;
  priority?: string;
  docType?: string;
  messageCount?: number;
  projectPath?: string;
  goal?: string;
  model?: string;
  agentType?: string;
  updatedAt?: number;
  viewedAt?: number;
  idleSummary?: string;
};

interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
  query?: string;
}

export const MentionList = forwardRef<any, MentionListProps>(
  ({ items, command, query }, ref) => {
    const [selection, setSelection] = useState({ query, index: 0 });
    const containerRef = useRef<HTMLDivElement>(null);
    const activeScope = useActiveMentionScope();
    const datesOnly = items.length > 0 && items.every((item) => item.type === "date");
    const { items: serverItems, loading: serverLoading } = useMentionServerSearch(
      datesOnly ? null : query ?? null,
      { teamId: activeScope.kind === "team" ? activeScope.teamId : null, types: SERVER_MENTION_TYPES },
    );
    const allItems = useMemo(
      () => datesOnly ? items : mergeMentionSuggestions(items, serverItems, mentionViewTimes(useInboxStore.getState())),
      [items, serverItems, datesOnly],
    );
    const selectedIndex = selection.query === query ? Math.min(selection.index, Math.max(0, allItems.length - 1)) : 0;
    const selectItem = useCallback((index: number) => {
      const item = allItems[index];
      if (item) command(item);
    }, [allItems, command]);
    const move = (delta: number) => {
      if (!allItems.length) return;
      const index = (selectedIndex + delta + allItems.length) % allItems.length;
      setSelection({ query, index });
      containerRef.current?.querySelectorAll("[role=option]")[index]?.scrollIntoView({ block: "nearest" });
    };
    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") { move(-1); return true; }
        if (event.key === "ArrowDown") { move(1); return true; }
        if (event.key === "Enter") { selectItem(selectedIndex); return true; }
        return false;
      },
    }));
    return (
      <div ref={containerRef} role="listbox" aria-label="Mention suggestions" className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 w-[420px] max-w-[calc(100vw-24px)] max-h-[400px] overflow-y-auto overflow-x-hidden">
        {allItems.length > 0 && allItems[0].type !== "date" && <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-sol-text-dim">Recently viewed · then updated</div>}
        {allItems.map((item, index) => (
          <button
            key={`${item.type}:${item.id}`} type="button" role="option" aria-selected={index === selectedIndex}
            data-mention-id={item.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectItem(index)}
            onMouseEnter={() => setSelection({ query, index })}
            className={`w-full text-left px-3 py-2 flex items-center gap-2.5 ${index === selectedIndex ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"}`}
          >
            <MentionSuggestion item={item} />
          </button>
        ))}
        {serverLoading && <div className="px-3 py-2 text-[11px] text-sol-text-dim" role="status">Searching everything…</div>}
        {!allItems.length && !serverLoading && <div className="px-3 py-2 text-xs text-sol-text-dim text-center">No results</div>}
      </div>
    );
  },
);

MentionList.displayName = "MentionList";
