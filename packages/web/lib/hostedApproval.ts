// Where a hosted conversation's approval stands, read from the transcript and
// the decision row rather than the work status (plan pl-840). The engine's
// permission_blocked status flips before the decision row lands and lags
// after it is answered, so a status read said "Waiting for your go-ahead"
// right above "You said yes. On it" (the same rule as decisionQueue.ts
// sessionHasOpenQuestion). The transcript (ConversationView), its receipt and
// the composer's status line all read this one answer. Below that, the card's
// own words (the plan as it shows it, what Yes does, the settled line), read
// by the web's HostedApprovalCard and the phone's ApprovalCard alike.

import { parseDecisionAnswer } from "@codecast/shared/contracts";
import { APPROVAL_ANSWERS, ROUTINE_SHOWS_UP } from "@codecast/shared/contracts/assistant";
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

// ── The card's words ─────────────────────────────────────────────────────

/** Whether a decision is an approval the engine wrote (a Yes and a Not now),
 *  which hosted mode draws as HostedApprovalBody wherever it shows. */
export function isHostedApproval(options: ReadonlyArray<{ label: string }>): boolean {
  return options.some((o) => o.label === APPROVAL_ANSWERS.approve) && options.some((o) => o.label === APPROVAL_ANSWERS.decline);
}

const CADENCE_WORDS = /\b(every|each|daily|weekly|monthly|weekdays?|weekends?|mornings?|evenings?|nights?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/i;
const WHEN_LINE = /^\*\*When:\*\*\s*/;

/** The plan as the card shows it. A routine's summary usually says its
 *  cadence already ("Every weekday at 7 AM I'll remind you"), and the yes line
 *  says when it starts, so a "When" line on top said the time a third time:
 *  it is left out then. Where it stays it reads as a quiet label, not bold. */
export function planForCard(contextMd: string): string {
  const blocks = contextMd.split(/\n{2,}/);
  const when = blocks.findIndex((b) => WHEN_LINE.test(b.trim()));
  if (when < 0) return contextMd;
  const summary = blocks.filter((_, i) => i !== when).join(" ");
  const said = CADENCE_WORDS.test(summary) && /\d/.test(summary);
  return (said ? blocks.filter((_, i) => i !== when) : blocks.map((b, i) => (i === when ? b.trim().replace(WHEN_LINE, "When: ") : b)))
    .join("\n\n");
}

/** What the settled card says between an answer and the turn moving on: the
 *  answer in the card's own words, then that the work is under way (or, for
 *  a no, that it is wrapping up). */
export function approvalSettledWords(label: string): string {
  if (label === APPROVAL_ANSWERS.decline) return "You said not now. Wrapping up…";
  if (label === APPROVAL_ANSWERS.always) return "You said always allow. On it…";
  return "You said yes. On it…";
}

/** A routine's yes says where it arrives (ROUTINE_SHOWS_UP). Cards asked
 *  before that line stopped promising notifications still carry the old
 *  words, which are read as the new. */
const LEGACY_SHOWS_UP = "You'll get it in your inbox, and as a notification when those are on.";

/** Said under a routine's yes while this device will not notify: a run then
 *  only waits in the inbox. `ask` while notifications are not on yet, `off`
 *  once they were refused (web RoutineNotifyLine, the phone's card). */
export const ROUTINE_NOTIFY_OFF = {
  ask: "Notifications are off on this device, so each run will only wait in your inbox.",
  off: "Notifications are blocked for Codecast on this device, so each run will only wait in your inbox.",
} as const;

export function yesWords(description: string): string {
  return description.replace(LEGACY_SHOWS_UP, ROUTINE_SHOWS_UP);
}

/** Whether a yes sets up a routine: its words say where the runs arrive. */
export function isRoutineYes(description: string): boolean {
  return description.includes(ROUTINE_SHOWS_UP) || description.includes(LEGACY_SHOWS_UP);
}
