// A decision's team thread as the store holds it (convex decisionThread.ts).
// Two collections, each fact once: `decisionThreads` holds who the thread
// talks to, one row per decision viewed; `decisionComments` holds every
// comment, reply and hand-off entry, keyed by the review_comments id. The
// viewer's unread state is the decision kind's threadInbox row.

export type DecisionThreadOwnerVia = "asker" | "run" | "lead" | "workspace";

/** decisionThread.thread's head, keyed by the decision's Convex id. */
export type DecisionThreadItem = {
  _id: string;
  decision_short_id?: string;
  owner: { conversation_id: string; short_id?: string; name: string; via: DecisionThreadOwnerVia } | null;
};

/** One entry of a decision's thread (convex DecisionComment). A local stub
 *  carries `dcstub-<client id>` as its id until the server row with the same
 *  client id supersedes it. */
export type DecisionCommentRow = {
  _id: string;
  decision_id: string;
  content: string;
  client_id?: string;
  created_at: number;
  updated_at?: number;
  /** The thread's root this one replies to. */
  parent_id?: string;
  author_kind?: "user" | "agent" | "github";
  author_user_id?: string;
  author_name: string;
  /** A hand-off entry: who handed it on (the author) and to whom. */
  decision_event?: "passed" | "escalated";
  event_to_names?: string[];
  /** A session's answer: "thinking" until it speaks, "error" when it could not be reached. */
  agent_status?: "thinking" | "streaming" | "done" | "error";
  /** The session an agent row speaks for. */
  decision_session_id?: string;
  /** An asked session's reply can still land or grow. */
  decision_waiting?: boolean;
  resolved_at?: number;
};

export const decisionCommentStubId = (clientId: string) => `dcstub-${clientId}`;

/** The row a comment paints as before the server has it. */
export function decisionCommentStub(o: { decisionId: string; text: string; clientId: string; parentId?: string; me?: { _id?: string; name?: string } }): DecisionCommentRow {
  return {
    _id: decisionCommentStubId(o.clientId),
    decision_id: o.decisionId,
    content: o.text.trim(),
    client_id: o.clientId,
    created_at: Date.now(),
    author_kind: "user",
    ...(o.parentId ? { parent_id: o.parentId } : {}),
    ...(o.me?._id ? { author_user_id: String(o.me._id) } : {}),
    author_name: o.me?.name ?? "You",
  };
}
