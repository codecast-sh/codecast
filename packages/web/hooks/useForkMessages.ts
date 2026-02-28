import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEffect } from "react";
import { useInboxStore } from "../store/inboxStore";

export function useForkMessages(forkConvId: string | null) {
  const setMessages = useInboxStore((s) => s.setMessages);
  const cached = useInboxStore((s) =>
    forkConvId ? s.messages[forkConvId] : undefined
  );

  const shouldSkip = !forkConvId || !!cached || forkConvId.startsWith("temp_");

  const result = useQuery(
    api.conversations.getForkBranchMessages,
    shouldSkip ? "skip" : { conversation_id: forkConvId! }
  );

  useEffect(() => {
    if (forkConvId && result && !("error" in result) && result.messages) {
      setMessages(forkConvId, result.messages as any);
    }
  }, [forkConvId, result, setMessages]);

  return {
    messages: cached || (result && !("error" in result) ? result.messages : null),
    isLoading: forkConvId ? !cached && result === undefined : false,
  };
}
