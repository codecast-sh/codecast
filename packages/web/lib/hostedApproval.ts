// Where a hosted conversation's approval stands, read from the transcript and
// the decision row rather than the work status (plan pl-840). The engine's
// permission_blocked status flips before the decision row lands and lags
// after it is answered, so a status read said "Waiting for your go-ahead"
// right above "You said yes. On it" (the same rule as decisionQueue.ts
// sessionHasOpenQuestion). The transcript (ConversationView), its receipt and
// the composer's status line all read this one answer.

import { parseDecisionAnswer } from "@codecast/shared/contracts";
import { answeredLabel } from "./decisionQueue";

type Row = { role?: string; content?: string; timestamp?: number; tool_calls?: Array<{ id: string }>; tool_results?: Array<{ tool_use_id: string }> };
type DecisionRow = { conversation_id?: string; created_at?: number; status?: string; answer_index?: number; options?: Array<{ label?: string }> };

/** When the transcript ends on a call still waiting for its result (a turn
 *  parked on an approval), the time of that message; null otherwise. The
 *  answer's own message (parseDecisionAnswer) may follow the call; once the
 *  answer resumes the turn, the result and the reply follow it too. */
export function parkedCallAt(rows: readonly Row[] | undefined): number | null {
  let end = rows?.length ?? 0;
  while (end > 0 && rows![end - 1].role === "user" && parseDecisionAnswer(rows![end - 1].content ?? "")) end--;
  const last = rows?.[end - 1];
  if (!last || last.role !== "assistant" || !last.tool_calls?.length) return null;
  const answered = new Set((last.tool_results ?? []).map((r) => r.tool_use_id));
  if (last.tool_calls.every((c) => answered.has(c.id))) return null;
  return Number(last.timestamp ?? 0);
}

/** A parked call's approval: "none" while nothing is parked; "pending"
 *  before its decision row lands; "open" while that row waits for the
 *  person; "answered:<label>" once the store holds their answer (the
 *  stored label, APPROVAL_ANSWERS). A string, so a store selector can
 *  return it without re-rendering on every decision push. */
export type HostedApprovalState = "none" | "pending" | "open" | `answered:${string}`;

export function hostedApprovalState(
  rows: readonly Row[] | undefined,
  decisions: Iterable<DecisionRow>,
  conversationId: string,
): HostedApprovalState {
  const parkedAt = parkedCallAt(rows);
  if (parkedAt === null) return "none";
  let open = false;
  for (const d of decisions) {
    if (d.conversation_id !== conversationId || (d.created_at ?? 0) < parkedAt) continue;
    const label = answeredLabel(d as any);
    if (label) return `answered:${label}`;
    if (d.status === "pending") open = true;
  }
  return open ? "open" : "pending";
}

/** The person's answer, once the store holds it. */
export function hostedApprovalAnswer(state: HostedApprovalState): string | null {
  return state.startsWith("answered:") ? state.slice("answered:".length) : null;
}

/** Whether the conversation waits on the person's go-ahead: an open
 *  decision for the parked call, or the engine parked and the row has not
 *  landed yet. Never once an answer is in, whatever the status still says. */
export function hostedAsks(state: HostedApprovalState, statusParked: boolean): boolean {
  return state === "open" || (state === "pending" && statusParked);
}
