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
  silent?: boolean;
  workflow_run_id?: string | null;
  created_at: number;
  resolved_at?: number | null;
};

/** A card asked this long before the station sent its brief still counts: the runner's clock and the server's differ. */
const CLOCK_SLACK_MS = 60_000;

/**
 * The decision a blocked wait waits on: the session's newest open card asked since the station sent its brief
 * (`after`; one it parked on before an advisory one), else one a person answered since the wait began, which ends the
 * wait on a person. A dismissed or withdrawn card ends nothing: the session still waits, and its pin says on what. A
 * run's own gate card, a pointer card and a trial's card are never the session's ask. None when the session asked in
 * words only, or only with a card from before this station.
 */
export function sessionAskOf(rows: Iterable<AskRow>, wait: { conversation_id?: string | null; since: number; after?: number | null } | null | undefined, viewer: string | null): SessionAsk | null {
  if (!wait?.conversation_id) return null;
  const after = (wait.after ?? 0) - CLOCK_SLACK_MS;
  let open: AskRow | null = null;
  let answered: AskRow | null = null;
  for (const d of rows) {
    if (!d || String(d.conversation_id) !== String(wait.conversation_id) || d.trial || d.silent || d.workflow_run_id) continue;
    if (d.status === "pending") {
      if (d.created_at < after) continue;
      if (!open || Number(!!d.blocking) > Number(!!open.blocking) || (!!d.blocking === !!open.blocking && d.created_at > open.created_at)) open = d;
    } else if (d.status === "answered" && (d.resolved_at ?? 0) >= wait.since && (!answered || (d.resolved_at ?? 0) > (answered.resolved_at ?? 0))) answered = d;
  }
  const d = open ?? answered;
  if (!d) return null;
  return { id: String(d._id), short_id: d.short_id ?? null, question: d.question, mine: canAnswer(d, viewer), open: d === open };
}

type AskRun = {
  status: string;
  waiting_on_session?: { node_id: string; conversation_id?: string; since: number; blocked?: boolean } | null;
  node_statuses?: ReadonlyArray<{ node_id: string; started_at?: number }> | null;
};

/** The wait a live run holds on a session that asks a person, with when its station sent the brief; null otherwise. */
export function blockedWaitOf(run: AskRun | null | undefined): { conversation_id?: string; since: number; after: number | null } | null {
  const w = run && (run.status === "running" || run.status === "paused") && run.waiting_on_session?.blocked ? run.waiting_on_session : null;
  if (!w) return null;
  const at = (run!.node_statuses ?? []).filter((n) => n.node_id === w.node_id).reduce<number | null>((t, n) => (n.started_at != null && (t == null || n.started_at > t) ? n.started_at : t), null);
  return { conversation_id: w.conversation_id, since: w.since, after: at };
}

/** A run's ask from the store's decision rows, for a surface with no hook (a list, a chip map). */
export const runAskOf = (run: AskRun | null | undefined, decisions: Readonly<Record<string, AskRow>>, viewer: string | null): SessionAsk | null => {
  const wait = blockedWaitOf(run);
  return wait ? sessionAskOf(Object.values(decisions), wait, viewer) : null;
};
