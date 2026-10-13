// How one decision a run asked stands (line-journeys.md LJ6.5), in one
// function every surface reads: the Decide step's groups and its row in the
// Steps table, a problem's Problems status and its band, and a run row's
// answer. Four states, never more:
//   waiting    asked, and an answer can still land
//   answered   a person chose; a trial answer is recorded and ships nothing
//   lapsed     asked, nobody answered in time, and the run went on without it
//   withdrawn  taken back, dismissed, or its run ended before anyone answered
// Only `answered` is an answer. Pure.
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { choiceWords } from "@codecast/shared/contracts/causeHistory";
import { wouldLabel } from "./fixDecision";
import { landWithoutYesWords } from "./runReport";

export type DecisionState = "waiting" | "answered" | "lapsed" | "withdrawn";

/** The decision row's fields this reads (session_decisions, lineCards, or a history AttemptCard's `status` and `answer`). */
export type OutcomeCard = {
  status: string;
  options?: ReadonlyArray<{ label: string }>;
  answer_index?: number | null;
  answer_text?: string | null;
  /** An answer already in words (AttemptCard.answer). */
  answer?: string | null;
  trial?: boolean;
  short_id?: string | null;
  resolved_at?: number | null;
  created_at?: number | null;
};

/** The run row's fields this reads. */
export type OutcomeRun = {
  status?: string;
  current_node_id?: string | null;
  gate_node_id?: string | null;
  gate_answer?: string | null;
  fail_reason?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null }>;
};

export type DecisionOutcome = {
  state: DecisionState;
  /** The option chosen, in its own words ("Ship"); null unless answered. */
  verb: string | null;
  /** Recorded in a trial: nothing it says was done. */
  trial: boolean;
  /** The state as every surface says it: "Ship", "Would ship · trial", "Lapsed", "Withdrawn", "Waiting". */
  words: string;
  /** The decision's ref (sd-N), when a session presented one. */
  ref: string | null;
  at: number | null;
  /** Why no answer can land any more, in the run's own words ("the problem was merged into another while the run waited"); null when it did not say. */
  why: string | null;
};

export const DECISION_STATE_WORDS: Record<DecisionState, string> = { waiting: "Waiting", answered: "Answered", lapsed: "Lapsed", withdrawn: "Withdrawn" };

const LIVE = new Set(["running", "paused", "pending", "waiting"]);

/** The run's own reason it stopped, when it gave one in words ("Stopped: …"), without the lead word. */
function stopWhy(run: OutcomeRun | null): string | null {
  const m = run?.fail_reason?.trim().match(/^stopped:\s*(.+?)\.?$/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : null;
}

/** The option a card was answered with, in its own words; null when it was not answered. */
function answerOf(card: OutcomeCard | null, run: OutcomeRun | null, gate: string): string | null {
  if (card?.status === "answered") {
    const raw = card.answer?.trim() || (card.answer_index != null ? card.options?.[card.answer_index]?.label : undefined) || card.answer_text?.trim();
    if (raw) return choiceWords(raw);
  }
  if (run?.gate_answer && (run.gate_node_id ?? CARD_GATE_NODE_ID) === gate) return choiceWords(run.gate_answer);
  return null;
}

/**
 * One decision's state: `card` is the decision the run's gate asked (the newest for that run and gate), `run` its run.
 * `unapproved` says the run went on past the card with no answer when the caller knows it without node statuses
 * (a history attempt's flag).
 */
export function decisionOutcome(card: OutcomeCard | null, run: OutcomeRun | null, opts: { gate?: string; trial?: boolean; unapproved?: boolean } = {}): DecisionOutcome {
  const gate = opts.gate ?? CARD_GATE_NODE_ID;
  const trial = !!(opts.trial || card?.trial);
  const ref = card?.short_id ?? null;
  const verb = answerOf(card, run, gate);
  if (verb) return { state: "answered", verb, trial, words: trial ? `${wouldLabel(verb)} · trial` : verb, ref, at: card?.resolved_at ?? null, why: null };
  const node = run?.node_statuses?.find((n) => n.node_id === gate);
  // A gate that came back with no answer records "failure"; the run then went on without it.
  const lapsed = !!opts.unapproved || node?.outcome === "failure";
  if (lapsed) return { state: "lapsed", verb: null, trial, words: DECISION_STATE_WORDS.lapsed, ref, at: card?.created_at ?? null, why: stopWhy(run) };
  const open = card ? card.status === "pending" || card.status === "waiting" : true;
  const runWaits = !run || (LIVE.has(run.status ?? "") && (run.current_node_id ?? gate) === gate);
  if (open && runWaits) return { state: "waiting", verb: null, trial, words: DECISION_STATE_WORDS.waiting, ref, at: card?.created_at ?? null, why: null };
  return { state: "withdrawn", verb: null, trial, words: DECISION_STATE_WORDS.withdrawn, ref, at: card?.resolved_at ?? card?.created_at ?? null, why: stopWhy(run) };
}

/** The decision a run's gate asked: its newest card for that gate (an older card with no gate belongs to the card gate). */
export function gateCard<C extends { workflow_run_id?: string | null; gate_node_id?: string | null; created_at?: number | null }>(cards: ReadonlyArray<C>, runId: string, gate: string): C | null {
  let best: C | null = null;
  for (const c of cards) {
    if (c.workflow_run_id !== runId || (c.gate_node_id ?? CARD_GATE_NODE_ID) !== gate) continue;
    if (!best || (c.created_at ?? 0) > (best.created_at ?? 0)) best = c;
  }
  return best;
}

/** The run's node records this reads to say what happened to a decision nobody answered. */
export type NoAnswerRun = OutcomeRun & {
  node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null; started_at?: number | null; completed_at?: number | null; result_preview?: string | null }>;
};

/**
 * Who took a fix decision back, why, and what the run did next, in words a person reads at a glance (ct-58282: three
 * cards "withdrawn" with no actor, each run going on to Ship). `by`: who withdrew it; `waited`: how long it was open
 * before the run stopped waiting (ms); `then`: what the landing step did after, from its own output. Null when the
 * run's records say nothing. A run that stops waiting goes on without an answer, and its end takes the card back
 * (convex workflow_runs withdrawOpenGate); a session's `cast decide cancel` fails the run with "gate withdrawn".
 */
export function noAnswerFacts(run: NoAnswerRun | null, gate: string = CARD_GATE_NODE_ID): { by: string; waited: number | null; then: string | null } | null {
  const nodes = run?.node_statuses ?? [];
  const at = nodes.findIndex((n) => n.node_id === gate);
  if (!run || at < 0) return null;
  const g = nodes[at];
  const waited = g.started_at != null && g.completed_at != null && g.completed_at > g.started_at ? g.completed_at - g.started_at : null;
  const by = /gate withdrawn/i.test(run.fail_reason ?? "") ? "The session that asked it" : stopWhy(run) ? `The line: ${stopWhy(run)!.charAt(0).toLowerCase()}${stopWhy(run)!.slice(1)}` : "The line, when its run ended";
  const land = nodes.slice(at + 1).find((n) => n.node_id === "ship" || n.node_id === "merge");
  return { by, waited, then: land ? landWithoutYesWords(land) : null };
}

