import { forwardRef, useImperativeHandle, useState, useCallback, useMemo } from "react";
import { useMentionServerSearch, useActiveMentionScope, SERVER_MENTION_TYPES } from "../../hooks/useMentionQuery";
import { mergeMentionSuggestions, mentionViewTimes, orderMentionItems } from "../../lib/mentionRanking";
import { useInboxStore } from "../../store/inboxStore";
import type { MentionItem } from "../../lib/mentionItem";
import { MentionMenu } from "./MentionMenu";
import { personifyAllNow } from "../../hooks/usePersonifyAll";

// The row type lives in lib/mentionItem so a library file (mentionRanking,
// useMentionQuery) and mobile's typecheck never pull this component in.
export type { MentionItem } from "../../lib/mentionItem";

interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
  query?: string;
}

export const MentionList = forwardRef<any, MentionListProps>(
  ({ items, command, query }, ref) => {
    const [selection, setSelection] = useState({ query, index: 0 });
    const activeScope = useActiveMentionScope();
    const datesOnly = items.length > 0 && items.every((item) => item.type === "date");
    const { items: serverItems, loading: serverLoading } = useMentionServerSearch(
      datesOnly ? null : query ?? null,
      { teamId: activeScope.kind === "team" ? activeScope.teamId : null, types: SERVER_MENTION_TYPES },
    );
    const allItems = useMemo(
      () => datesOnly ? items : orderMentionItems(mergeMentionSuggestions(items, serverItems, mentionViewTimes(useInboxStore.getState()), Infinity, query ?? "", personifyAllNow())),
      [items, serverItems, datesOnly, query],
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
      <MentionMenu
        items={allItems}
        selectedIndex={selectedIndex}
        onHover={(index) => setSelection({ query, index })}
        onPick={selectItem}
        query={query}
        loading={serverLoading}
        heading={datesOnly ? "Dates" : undefined}
        className="w-[520px] max-w-[calc(100vw-24px)]"
      />
    );
  },
);

MentionList.displayName = "MentionList";
