"use client";
// The line's chat (docs/architecture/line-workspace.md LW4, convex lineChat.ts):
// the per-view feeder (lineChat.thread into the lineChats collection) and the
// thread read from the store, local echoes included. Sending paints the words
// at once and takes them back if the server refuses them.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { settleEchoedSend } from "../lib/decisionDiscussion";
import { lineChatThread, type LineChatItem } from "../lib/line/lineChat";

const api = _api as any;

export function useLineChat(projectId: string | null) {
  const args = useMemo(() => (projectId ? { project_id: projectId } : "skip"), [projectId]);
  const { ready } = useSyncCollection("lineChats", api.lineChat.thread, args as any, { select: (row: LineChatItem | null) => (row ? [row] : []) });
  const row = useInboxStore((s) => (projectId ? ((s as unknown as { lineChats?: Record<string, LineChatItem> }).lineChats?.[projectId]) : undefined));
  const sends = useInboxStore((s) => (projectId ? s.lineChatSends[projectId] : undefined));
  const thread = useMemo(() => lineChatThread(row, sends), [row, sends]);
  return { ready, owner: row?.owner ?? null, thread };
}

export const newLineChatClientId = () => `line-chat:${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/** Send words to the line, with what the person has open (`focus`, in words);
 *  resolves with the refusal's reason, or null once they are on their way. */
export function sendLineChat(projectId: string, text: string, graph: string | null, focus: string | null, clientId = newLineChatClientId()): Promise<string | null> {
  return settleEchoedSend(
    useInboxStore.getState().sendLineChat(projectId, text, clientId, graph, focus),
    () => useInboxStore.getState().dropLineChatSend(projectId, clientId),
  );
}
