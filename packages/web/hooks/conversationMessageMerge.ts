import { isTaggedDecisionAnswer } from "@codecast/shared/contracts";
import type { Message } from "./useConversationMessages";

/**
 * The rendered list: every row the session has taken, in transcript order,
 * then every row it has not taken yet, in send order. A pending row NEVER
 * sorts among confirmed rows by timestamp: it carries the local send time
 * while a confirmed row carries the transcript time, and a paste the agent
 * picks up late is echoed after a newer send left this window. The session
 * has not read a pending row, so nothing it has read can come after it.
 *
 * One kind of row is placed instead (`hosted`): an approval's answer in a
 * conversation with the hosted assistant. Its turn consumes the answer and
 * never writes it to the transcript (isTaggedDecisionAnswer), so its bubble
 * meets no echo and would trail the conversation for good, below everything
 * said after it. It sits where the conversation stood when it was sent
 * (`_sentBaselineTs`, the row's server stamp then): right after the rows that
 * were there, where the approval card was, and after any answer already
 * placed there, so two answers given together keep their order.
 */
export function mergeUnconfirmedMessages(storeMessages: Message[], storePending: Message[], hosted = false): Message[] {
  if (storePending.length === 0) return storeMessages;
  // Dedup by both _id (optimistic messages now live in messages[]) and client_id (server-confirmed)
  const storeIds = new Set(storeMessages.map((m) => m._id));
  const serverClientIds = new Set(storeMessages.filter((m) => m.client_id).map((m) => m.client_id));
  const unconfirmed = storePending.filter((m) =>
    !m._isLocalQueue && !storeIds.has(m._id) && (!m._clientId || !serverClientIds.has(m._clientId))
  ).sort((a, b) => a.timestamp - b.timestamp);
  if (unconfirmed.length === 0) return storeMessages;
  const answers = hosted ? unconfirmed.filter((m) => isTaggedDecisionAnswer(m.content)) : [];
  if (answers.length === 0) return [...storeMessages, ...unconfirmed];
  const isAnswer = new Set<Message>(answers);
  // An answer the server already took is a note about a place in the
  // transcript. Before any of the transcript is read back it has no place,
  // so it waits rather than standing alone on a cold open.
  if (storeMessages.length === 0) return unconfirmed.filter((m) => !(isAnswer.has(m) && m._isSettled));
  const placed = [...storeMessages];
  for (const answer of answers) {
    const sentAt = answer._sentBaselineTs ?? answer.timestamp;
    let at = 0;
    for (let i = placed.length - 1; i >= 0; i--) {
      if (!isAnswer.has(placed[i]) && placed[i].timestamp <= sentAt) {
        at = i + 1;
        break;
      }
    }
    while (at < placed.length && isAnswer.has(placed[at])) at++;
    placed.splice(at, 0, answer);
  }
  return [...placed, ...unconfirmed.filter((m) => !isAnswer.has(m))];
}

// Convex patches the active streaming message in place, so its id and the list
// length stay fixed while content/thinking/tools grow. Keep the cheap structural
// guard, but include the full live tail so partial and final same-id updates are
// never mistaken for an unchanged page.
export function messagePageSyncKey(conversationId: string, messages: Message[]): string {
  return JSON.stringify([
    conversationId,
    messages.length,
    messages[0]?._id,
    messages[messages.length - 1],
  ]);
}
