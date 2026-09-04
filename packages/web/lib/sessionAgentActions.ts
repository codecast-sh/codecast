import { captureException } from "@sentry/react";
import type { ConvexAgentType } from "@codecast/shared/contracts";
import { isConvexId, type InboxSession, useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";

export async function switchSessionAgent(
  session: Pick<InboxSession, "_id" | "agent_type">,
  targetAgentType: ConvexAgentType,
): Promise<void> {
  const store = useInboxStore.getState();
  const id = store.getConvexId(session._id) ?? session._id;
  const previousAgentType = session.agent_type || "claude_code";
  if (previousAgentType === targetAgentType) return;

  store.setConversationAgent(id, targetAgentType);
  if (!isConvexId(id)) return;

  try {
    await store.convCommand(id, "switchSessionAgent", { agent_type: targetAgentType });
  } catch (error) {
    if (isParkedDispatchError(error)) return;
    captureException(error);
    useInboxStore.getState().setConversationAgent(id, previousAgentType);
    throw error;
  }
}

export function forkSessionAsAgent(
  session: Pick<InboxSession, "_id" | "title" | "agent_type" | "project_path" | "git_root">,
  targetAgentType: ConvexAgentType,
): { sessionId: string; ready: Promise<string> } {
  const store = useInboxStore.getState();
  const parentId = store.getConvexId(session._id) ?? session._id;
  if (!isConvexId(parentId)) throw new Error("Session is still being created — try again in a moment");

  const sessionId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const value = (Math.random() * 16) | 0;
        return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
      });
  const now = Date.now();
  const row = {
    _id: sessionId,
    session_id: sessionId,
    title: session.title,
    agent_type: targetAgentType,
    project_path: session.project_path,
    git_root: session.git_root,
    started_at: now,
    updated_at: now,
    status: "active",
    message_count: 0,
    is_idle: true,
    has_pending: false,
    forked_from: parentId,
    parent_conversation_id: parentId,
    parent_message_uuid: "agent-switch",
    fork_status: "copying" as const,
    _forkTargetAgentType: targetAgentType,
  };

  store.syncRecord("conversations", sessionId, row);
  store.injectSession(row);
  store.moveDraft(parentId, sessionId);

  const dispatch = store.convCommand(parentId, "forkFromMessage", {
    target_agent_type: targetAgentType,
    session_id: sessionId,
  }).then((result) => {
    const conversationId = result.conversation_id as string;
    useInboxStore.getState().resolveForkSessionId(sessionId, conversationId);
    return conversationId;
  });
  store.trackSessionCreate(sessionId, dispatch);

  const ready = dispatch.catch((error) => {
    if (isParkedDispatchError(error)) return sessionId;
    captureException(error);
    const latest = useInboxStore.getState();
    latest.moveDraft(sessionId, parentId);
    latest.discardForkStub(sessionId, parentId);
    throw error;
  });

  return { sessionId, ready };
}
