import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEffect } from "react";
import { useForkNavigationStore } from "../store/forkNavigationStore";

export function useForkMessages(forkConvId: string | null) {
  const setForkMessages = useForkNavigationStore((s) => s.setForkMessages);
  const cached = useForkNavigationStore((s) =>
    forkConvId ? s.loadedForkMessages[forkConvId] : undefined
  );

  const result = useQuery(
    api.conversations.getForkBranchMessages,
    forkConvId && !cached ? { conversation_id: forkConvId } : "skip"
  );

  useEffect(() => {
    if (forkConvId && result && !("error" in result) && result.messages) {
      setForkMessages(forkConvId, result.messages as any);
    }
  }, [forkConvId, result, setForkMessages]);

  return {
    messages: cached || (result && !("error" in result) ? result.messages : null),
    isLoading: forkConvId ? !cached && result === undefined : false,
  };
}
