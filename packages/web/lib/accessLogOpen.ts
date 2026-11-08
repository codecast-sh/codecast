// The app's half of the regulated-data access log (convex accessLog.ts): an
// open that has no server read of its own to ride (the transcript paints from
// the local store) is reported once per mount with one small mutation. Only
// a viewer who belongs to a regulated team, or who holds a share link, asks
// at all; the server decides again from the object's own team.
import { useMutation } from "convex/react";
import { useRef } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { isDesktop } from "./desktop";
import { getShareTokenScope } from "./shareTokenScope";
import { viewerTeamIsRegulated } from "./regulatedData";

export type AppClient = "web" | "desktop";

export const appClient = (): AppClient => (isDesktop() ? "desktop" : "web");

/** Report one open of a conversation per mount and conversation, for a regulated team's conversation. */
export function useRecordConversationOpen(conversationId: string | null | undefined, teamId: string | null | undefined): void {
  const note = useMutation(api.accessLog.noteConversationAccess);
  const sent = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!conversationId || conversationId.startsWith("optimistic") || sent.current === conversationId) return;
    const shareToken = getShareTokenScope(conversationId);
    if (!shareToken && !viewerTeamIsRegulated(teamId)) return;
    sent.current = conversationId;
    void note({
      conversation_id: conversationId as Id<"conversations">,
      action: "open",
      client: appClient(),
      ...(shareToken ? { share_token: shareToken } : {}),
    }).catch(() => {});
  }, [conversationId, teamId, note]);
}

/** Report one open of a call's recording per mount and call, for a regulated team's call. */
export function useRecordCallRecordingOpen(callRef: string | null | undefined, teamId: string | null | undefined, hasVideo: boolean): void {
  const note = useMutation(api.accessLog.noteCallRecordingOpen);
  const sent = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!callRef || !hasVideo || sent.current === callRef || !viewerTeamIsRegulated(teamId)) return;
    sent.current = callRef;
    void note({ call: callRef, client: appClient() }).catch(() => {});
  }, [callRef, teamId, hasVideo, note]);
}

/** Report a file saved out of a conversation; the caller fires it on the press. */
export function useRecordConversationDownload(): (conversationId: string | null | undefined, fileName: string) => void {
  const note = useMutation(api.accessLog.noteConversationAccess);
  return (conversationId, fileName) => {
    const conv = conversationId ? (useInboxStore.getState().conversations as Record<string, { team_id?: string } | undefined>)[conversationId] : null;
    if (!conversationId || !viewerTeamIsRegulated(conv?.team_id)) return;
    void note({ conversation_id: conversationId as Id<"conversations">, action: "download", client: appClient(), detail: fileName }).catch(() => {});
  };
}
