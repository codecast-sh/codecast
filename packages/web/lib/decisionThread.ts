// A decision's team thread as a surface draws it (convex decisionThread.ts):
// its rows as the shared comment components' Comments, a hand-off as an
// event line, and the writes. The card, the decision page, the Threads page
// and the phone read the same thread.
import { useInboxStore } from "../store/inboxStore";
import type { DecisionCommentRow } from "../store/decisionThreadTypes";
import type { Comment } from "./commentThread";
import { settleEchoedSend } from "./decisionDiscussion";

/** "passed to Samvit" / "escalated to Armen and Ashot". */
export function handoffWords(entry: Pick<DecisionCommentRow, "decision_event" | "event_to_names">): string {
  const names = entry.event_to_names ?? [];
  const who = names.length <= 1 ? names[0] ?? "someone" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${entry.decision_event === "escalated" ? "escalated" : "passed"} to ${who}`;
}

/** The thread's rows as the shared comment components draw them (lib/commentThread
 *  Comment): `sessionId` is the session the thread's agent rows speak for. */
export function decisionThreadComments(rows: readonly DecisionCommentRow[], sessionId: string): Comment[] {
  return [...rows]
    .sort((a, b) => a.created_at - b.created_at || a._id.localeCompare(b._id))
    .map((r) => ({
      _id: r._id,
      conversation_id: sessionId,
      user_id: r.author_user_id ?? "",
      content: r.content,
      parent_comment_id: r.parent_id ?? null,
      created_at: r.created_at,
      author_kind: r.author_kind === "agent" ? "agent" : "user",
      agent_status: r.agent_status ?? null,
      client_id: r.client_id ?? null,
      resolved_at: r.resolved_at ?? null,
      user: { name: r.author_name },
      author_name: r.author_kind === "agent" ? r.author_name || null : null,
      event: r.decision_event ? handoffWords(r) : null,
    }));
}

/** The Threads row id of a decision's thread (threadInbox `${kind}:${root_key}`). */
export const decisionThreadRowId = (decisionId: string) => `decision:decision:${decisionId}`;
export const decisionThreadRootKey = (decisionId: string) => `decision:${decisionId}`;

export function newDecisionCommentId(): string {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `decision-thread:${id}`;
}

/** Send a comment: it paints at once, and a refusal takes the stub back and resolves with the reason. */
export async function sendDecisionComment(decisionId: string, text: string, clientId: string, parentId?: string): Promise<string | null> {
  return settleEchoedSend(
    useInboxStore.getState().commentOnDecision(decisionId, text, clientId, parentId),
    () => useInboxStore.getState().dropDecisionComment(clientId),
  );
}

/** Ask the decision's session about the thread: its answer fills a placeholder. */
export async function askDecisionSession(decisionId: string): Promise<string | null> {
  const clientId = newDecisionCommentId();
  return settleEchoedSend(
    useInboxStore.getState().askDecisionSession(decisionId, clientId),
    () => useInboxStore.getState().dropDecisionComment(clientId),
  );
}

/** Mark the viewer's thread read, when it has news. */
export function markDecisionThreadRead(decisionId: string): void {
  useInboxStore.getState().markThreadRead("decision", decisionThreadRootKey(decisionId));
}
