import { useState } from "react";
import { useConvex } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { captureException } from "@sentry/react";
import { toast } from "sonner";
import type { MonitorRow } from "../components/monitorRows";
import { isOnThreadRoute, openSessionAtMessage } from "../lib/openSessionAtMessage";
import { resolveWatchMessage, resolveWorkflowMessage } from "../lib/resolveWatchMessage";
import { useInboxStore } from "../store/inboxStore";
import { fetchMessagesAround } from "./inboxWarm";

// Jump from a card's child row (a monitor, a background command, a workflow
// run) to the spot in the conversation where it started. `openingKey` names
// the row whose lookup is in flight.
export function useOpenWatchMessage(conversationId: string) {
  const convex = useConvex();
  const router = useRouter();
  const pathname = usePathname();
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const loadAround = (timestamp: number) => fetchMessagesAround(convex, conversationId, timestamp, 50, 50);

  const openAt = async (
    key: string,
    what: string,
    resolve: () => Promise<{ messageId: string; timestamp: number } | null>,
  ) => {
    setOpeningKey(key);
    try {
      const target = await resolve();
      if (!target) {
        toast.error(`Couldn't find this ${what}'s message in the conversation`);
        return;
      }
      if (isOnThreadRoute(pathname)) {
        openSessionAtMessage(conversationId, target.messageId, target.timestamp);
      } else {
        router.push(`/conversation/${conversationId}#msg-${target.messageId}`);
      }
    } catch (error) {
      captureException(error);
      toast.error(`Couldn't open this ${what}'s message`, { description: "Try again." });
    } finally {
      setOpeningKey(null);
    }
  };

  const messages = () => useInboxStore.getState().messages[conversationId];

  const openWatchMessage = (row: MonitorRow) =>
    openAt(row.toolUseId, "task", () => resolveWatchMessage(row, messages(), loadAround));

  const openWorkflowMessage = (runId: string, startedAt: number) =>
    openAt(runId, "workflow", () => resolveWorkflowMessage(startedAt, messages(), loadAround));

  return { openWatchMessage, openWorkflowMessage, openingKey };
}
