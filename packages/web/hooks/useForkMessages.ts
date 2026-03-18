import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

export function useForkMessages(forkConvId: string | null) {
  const setMessages = useInboxStore((s) => s.setMessages);
  const cached = useInboxStore((s) =>
    forkConvId ? s.messages[forkConvId] : undefined
  );

  const shouldSkip = !forkConvId || !!cached || !isConvexId(forkConvId);

  const result = useQuery(
    api.conversations.getForkBranchMessages,
    shouldSkip ? "skip" : { conversation_id: forkConvId! }
  );

  useConvexSync(result, useCallback((data: any) => {
    if (forkConvId && !("error" in data) && data.messages) {
      setMessages(forkConvId, data.messages as any);
    }
  }, [forkConvId, setMessages]));

  return {
    messages: cached || (result && !("error" in result) ? result.messages : null),
    isLoading: forkConvId ? !cached && result === undefined : false,
  };
}
