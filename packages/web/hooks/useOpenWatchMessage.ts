import { useState } from "react";
import { useConvex } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { captureException } from "@sentry/react";
import { toast } from "sonner";
import type { MonitorRow } from "../components/monitorRows";
import { isOnThreadRoute, openSessionAtMessage } from "../lib/openSessionAtMessage";
import { resolveWatchMessage } from "../lib/resolveWatchMessage";
import { useInboxStore } from "../store/inboxStore";
import { fetchMessagesAround } from "./inboxWarm";

export function useOpenWatchMessage(conversationId: string) {
  const convex = useConvex();
  const router = useRouter();
  const pathname = usePathname();
  const [openingToolId, setOpeningToolId] = useState<string | null>(null);

  const openWatchMessage = async (row: MonitorRow) => {
    setOpeningToolId(row.toolUseId);
    try {
      const target = await resolveWatchMessage(row, useInboxStore.getState().messages[conversationId],
        (timestamp) => fetchMessagesAround(convex, conversationId, timestamp, 50, 50));
      if (!target) {
        toast.error("Couldn't find this task's message in the conversation");
        return;
      }
      if (isOnThreadRoute(pathname)) {
        openSessionAtMessage(conversationId, target.messageId, target.timestamp);
      } else {
        router.push(`/conversation/${conversationId}#msg-${target.messageId}`);
      }
    } catch (error) {
      captureException(error);
      toast.error("Couldn't open this task's message", { description: "Try again." });
    } finally {
      setOpeningToolId(null);
    }
  };

  return { openWatchMessage, openingToolId };
}
