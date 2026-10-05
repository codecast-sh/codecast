// What waits for a hosted conversation's next turn (plan pl-840,
// docs/architecture/hosted-assistant.md "The turn"): the person's queued
// words, answers to the approval card, and the turn parked on that card. A
// leaf module (types and the shared contracts only), so the stuck-message
// sweep in pendingMessages can read it without importing the turn engine.
import { decisionIdFromClientId, parseDecisionAnswer } from "@codecast/shared/contracts";
import type { QueryCtx } from "../functions";
import type { Doc, Id } from "../_generated/dataModel";

type Db = Pick<QueryCtx, "db">;
export type Turn = Doc<"assistant_turns">;

/** The decision a pending row answers, when it is an answer: the server's
 *  delivery names it in its client id, the web's send in its tagged text
 *  (formatDecisionAnswer). Null for anything a person typed. */
export function decisionAnswerOf(row: Pick<Doc<"pending_messages">, "client_id" | "content">): string | null {
  // The legacy untagged "Decision: ..." names no decision, and a person may
  // type exactly that, so only a tagged answer counts.
  return decisionIdFromClientId(row.client_id) ?? (parseDecisionAnswer(row.content)?.id || null);
}

export function turnsIn(ctx: Db, conversationId: Id<"conversations">, status: Turn["status"]): Promise<Turn[]> {
  return ctx.db
    .query("assistant_turns")
    .withIndex("by_conversation_status", (q) => q.eq("conversation_id", conversationId).eq("status", status))
    .collect();
}

/** What is waiting for the conversation's next turn. */
export interface Input {
  /** Pending rows a person or a routine wrote, oldest first. */
  typed: Doc<"pending_messages">[];
  /** Pending rows that answer a decision; never written to the transcript. */
  answers: Doc<"pending_messages">[];
  /** The turn parked on an approval, and the decision it asked. */
  waiting: Turn | null;
  decision: Doc<"session_decisions"> | null;
  /** The decision is no longer pending: answered, dismissed or gone. */
  resolved: boolean;
  /** The person wrote again after the card went up, instead of answering.
   *  Only their own words count: a routine firing meanwhile waits for the
   *  answer like any input that came before the card. */
  movedOn: boolean;
  /** A turn has something to do. */
  ready: boolean;
  /** An answer to the open decision arrived before the decision row itself
   *  turned answered (the web sends both, in either order). */
  answerAhead: boolean;
}

export async function pendingInput(ctx: Db, conversationId: Id<"conversations">): Promise<Input> {
  const pending = (await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q) => q.eq("conversation_id", conversationId).eq("status", "pending"))
    .collect()).sort((a, b) => a.created_at - b.created_at);
  const answers = pending.filter((row) => decisionAnswerOf(row) !== null);
  const typed = pending.filter((row) => decisionAnswerOf(row) === null);
  const parked = (await turnsIn(ctx, conversationId, "waiting")).sort((a, b) => b._creationTime - a._creationTime);
  const waiting = parked[0] ?? null;
  const decisionId = waiting?.pending_call?.decision_id;
  const decision = decisionId ? await ctx.db.get(decisionId) : null;
  const resolved = !!waiting && decision?.status !== "pending";
  const since = decision?.created_at ?? waiting?.ended_at ?? 0;
  const movedOn = !!waiting && typed.some((row) => row.human === true && row.created_at > since);
  const answerAhead = !!decision && decision.status === "pending" && answers.some((row) => decisionAnswerOf(row) === String(decision._id));
  return {
    typed,
    answers,
    waiting,
    decision,
    resolved,
    movedOn,
    ready: waiting ? resolved || movedOn : typed.length > 0,
    answerAhead,
  };
}

/** True while the conversation's input waits on an open approval card: a
 *  turn is parked on a decision still pending, and the person has not written
 *  since. Waking it then changes nothing; the answer, a dismissal or their
 *  next message wakes it. The stuck-message sweep skips such a conversation. */
export async function hostedInputWaits(ctx: Db, conversationId: Id<"conversations">): Promise<boolean> {
  const input = await pendingInput(ctx, conversationId);
  return !!input.waiting && !input.ready;
}
