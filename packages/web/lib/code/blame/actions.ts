// What a blame hunk opens: the conversation that wrote it, beside the editor.

import type { CodeBlameSession } from "@codecast/shared/contracts";
import { openBeside, sessionPanePath } from "../../stage";
import { openSessionAtMessage } from "../../openSessionAtMessage";

/** The conversation's full id, when the daemon resolved one. */
export function blameConversationId(session: CodeBlameSession | undefined): string | null {
  return session?.conversation_id ?? null;
}

/**
 * Open the session beside the editor. A stage pane opens a conversation at
 * its latest turn; where the stage has no room, the conversation opens in
 * place, at the message that made the edit when it is known.
 */
export function openBlameSession(session: CodeBlameSession | undefined): boolean {
  const id = blameConversationId(session);
  if (!id) return false;
  if (openBeside(sessionPanePath(id))) return true;
  openSessionAtMessage(id, session?.message_id);
  return true;
}

/** Go to the message that made the edit, in the main view. */
export function openBlameMessage(session: CodeBlameSession | undefined): boolean {
  const id = blameConversationId(session);
  if (!id || !session?.message_id) return false;
  openSessionAtMessage(id, session.message_id);
  return true;
}
