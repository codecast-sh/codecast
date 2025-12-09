import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";

export function useConversationsWithError(filter: "my" | "team") {
  const conversations = useQuery(api.conversations.listConversations, { filter });
  const [hasShownError, setHasShownError] = useState(false);
  const loadingStartTime = useRef<number | null>(null);
  const retryToastId = useRef<string | number | null>(null);

  useEffect(() => {
    if (conversations === undefined) {
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
  }, [conversations, hasShownError]);

  return conversations;
}
