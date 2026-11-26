// What a run's subject session asks a person while the run waits on it (flows.md FL4, ct-99051): the session pinned
// blocked, and the card it asked with (`cast decide`) is the decision the run waits on. The card names it, and the
// person answers it right on the run's card; the answer reaches the session, whose next turn resumes the run.
import { canAnswer, type GateDecision } from "./journey";

/** The session's ask, as the run card draws it. `open: false`: answered since the wait began, so nobody waits on a person. */
export type SessionAsk = { id: string; short_id: string | null; question: string; mine: boolean; open: boolean };

export type AskRow = GateDecision & {
  _id: string;
  short_id?: string | null;
  conversation_id: string;
  question: string;
  status: string;
  blocking?: boolean;
  trial?: boolean;
  created_at: number;
  resolved_at?: number | null;
};

/**
 * The decision a blocked wait waits on: the session's newest open card (one it parked on before an advisory one), else
 * one it had answered since the wait began, which ends the wait on a person. None when the session asked in words only.
 */
export function sessionAskOf(rows: Iterable<AskRow>, wait: { conversation_id?: string | null; since: number } | null | undefined, viewer: string | null): SessionAsk | null {
  if (!wait?.conversation_id) return null;
  let open: AskRow | null = null;
  let settled: AskRow | null = null;
  for (const d of rows) {
    if (!d || String(d.conversation_id) !== String(wait.conversation_id) || d.trial) continue;
    if (d.status === "pending") {
      if (!open || Number(!!d.blocking) > Number(!!open.blocking) || (!!d.blocking === !!open.blocking && d.created_at > open.created_at)) open = d;
    } else if ((d.resolved_at ?? 0) >= wait.since && (!settled || (d.resolved_at ?? 0) > (settled.resolved_at ?? 0))) settled = d;
  }
  const d = open ?? settled;
  if (!d) return null;
  return { id: String(d._id), short_id: d.short_id ?? null, question: d.question, mine: canAnswer(d, viewer), open: d === open };
}
