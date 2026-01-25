import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

type ConversationResult = ReturnType<typeof useQuery<typeof api.conversations.listConversations>>;

export function useConversationsWithError(filter: "my" | "team", memberId?: string | null) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [allConversations, setAllConversations] = useState<any[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const result = useQuery(api.conversations.listConversations, {
    filter,
    cursor,
    memberId: memberId ? (memberId as Id<"users">) : undefined,
  });
  const [hasShownError, setHasShownError] = useState(false);
  const loadingStartTime = useRef<number | null>(null);
  const retryToastId = useRef<string | number | null>(null);

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

  // Update conversations when result changes
  useEffect(() => {
    if (result?.conversations) {
      if (cursor) {
        // Append to existing
        setAllConversations(prev => {
          const existingIds = new Set(prev.map(c => c._id));
          const newConvs = result.conversations.filter(c => !existingIds.has(c._id));
          return [...prev, ...newConvs];
        });
      } else {
        // Replace (initial load or filter change)
        setAllConversations(result.conversations);
      }
      setIsLoadingMore(false);
    }
  }, [result, cursor]);

  // Reset when filter or memberId changes
  useEffect(() => {
    setCursor(undefined);
    setAllConversations([]);
  }, [filter, memberId]);

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
  };
}
