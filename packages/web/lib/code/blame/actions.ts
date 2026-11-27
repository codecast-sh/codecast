// What a blame hunk opens: the conversation that wrote it, beside the editor.

import type { CodeBlameSession } from "@codecast/shared/contracts";
import { openBeside, sessionPanePath } from "../../stage";
import { isOnThreadRoute, openSessionAtMessage } from "../../openSessionAtMessage";
import { navigateHere } from "../../openIntent";

/** The conversation's full id, when the daemon resolved one. */
export function blameConversationId(session: CodeBlameSession | undefined): string | null {
  return session?.conversation_id ?? null;
}

/**
 * Open a conversation in the main view, at a message when one is given. On a
 * thread route the inbox is mounted and reads the store's navigate request;
 * anywhere else (the editor's own /files page) that request would sit unread
 * until the inbox next mounts, so the deep link is followed instead, the same
 * split EntityIdPill's message links make.
 */
export function openConversationHere(conversationId: string, messageId?: string | null): void {
  if (isOnThreadRoute()) {
    openSessionAtMessage(conversationId, messageId);
    return;
  }
  navigateHere(`/conversation/${conversationId}${messageId ? `#msg-${messageId}` : ""}`);
}

/**
 * Open the session beside the editor. A stage pane opens a conversation at
 * its latest turn; where the stage has no room, the conversation opens in
 * the main view, at the message that made the edit when it is known.
 */
export function openBlameSession(session: CodeBlameSession | undefined): boolean {
  const id = blameConversationId(session);
  if (!id) return false;
  if (openBeside(sessionPanePath(id))) return true;
  openConversationHere(id, session?.message_id);
  return true;
}

/** Go to the message that made the edit, in the main view. */
export function openBlameMessage(session: CodeBlameSession | undefined): boolean {
  const id = blameConversationId(session);
  if (!id || !session?.message_id) return false;
  openConversationHere(id, session.message_id);
  return true;
}
