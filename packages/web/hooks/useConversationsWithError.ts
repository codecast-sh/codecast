import { useRef, useState, useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";

type ConversationResult = ReturnType<typeof useQuery<typeof api.conversations.listConversations>>;

export function useConversationsWithError(
  filter: "my" | "team",
  memberId?: string | null,
  subagentFilter?: "main" | "subagent" | null,
  directoryFilter?: string | null,
  timeFilter?: "long" | "active" | null,
) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [allConversations, setAllConversations] = useState<any[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;

  const result = useQuery(api.conversations.listConversations, {
    filter,
    cursor,
    include_message_previews: true,
    memberId: memberId ? (memberId as Id<"users">) : undefined,
    activeTeamId: filter === "team" && activeTeamId ? activeTeamId : undefined,
    subagentFilter: subagentFilter || undefined,
    directoryFilter: directoryFilter || undefined,
    timeFilter: timeFilter || undefined,
  });
  const [hasShownError, setHasShownError] = useState(false);
  const loadingStartTime = useRef<number | null>(null);
  const retryToastId = useRef<string | number | null>(null);

  // Reset when any filter changes
  const [trackedFilters, setTrackedFilters] = useState({ filter, memberId, activeTeamId, subagentFilter, directoryFilter, timeFilter });
  if (
    trackedFilters.filter !== filter ||
    trackedFilters.memberId !== memberId ||
    trackedFilters.activeTeamId !== activeTeamId ||
    trackedFilters.subagentFilter !== subagentFilter ||
    trackedFilters.directoryFilter !== directoryFilter ||
    trackedFilters.timeFilter !== timeFilter
  ) {
    setTrackedFilters({ filter, memberId, activeTeamId, subagentFilter, directoryFilter, timeFilter });
    setCursor(undefined);
    setAllConversations([]);
  }

  // eslint-disable-next-line no-restricted-syntax -- timeout-based error toast requires reactive timer
  useEffect(() => {
    if (result === undefined) {
      if (loadingStartTime.current === null) {
        loadingStartTime.current = Date.now();
      }

      const elapsed = Date.now() - loadingStartTime.current;

      if (elapsed > 5000 && !hasShownError) {
        setHasShownError(true);

        retryToastId.current = toast.error("Network error loading conversations", {
          description: "Unable to connect to the server. Check your connection.",
          action: {
            label: "Retry",
            onClick: () => {
              setHasShownError(false);
              loadingStartTime.current = Date.now();
              window.location.reload();
            },
          },
          duration: Infinity,
        });
      }
    } else {
      loadingStartTime.current = null;

      if (hasShownError && retryToastId.current !== null) {
        toast.dismiss(retryToastId.current);
        retryToastId.current = null;
        setHasShownError(false);
        toast.success("Connected successfully");
      }
    }
  }, [result, hasShownError]);

  // eslint-disable-next-line no-restricted-syntax -- cursor-dependent pagination merge
  useEffect(() => {
    if (result?.conversations) {
      if (cursor) {
        setAllConversations(prev => {
          const existingIds = new Set(prev.map(c => c._id));
          const newConvs = result.conversations.filter((c: any) => !existingIds.has(c._id));
          return [...prev, ...newConvs];
        });
      } else {
        setAllConversations(result.conversations);
      }
      setIsLoadingMore(false);
    }
  }, [result, cursor]);

  const loadMore = useCallback(() => {
    if (result?.nextCursor && !isLoadingMore) {
      setIsLoadingMore(true);
      setCursor(result.nextCursor);
    }
  }, [result?.nextCursor, isLoadingMore]);

  return {
    conversations: allConversations,
    hasMore: !!result?.nextCursor,
    loadMore,
    isLoadingMore,
    isLoading: result === undefined,
    hasSubagents: result?.hasSubagents ?? false,
  };
}
