// A trial card read against its problem's evidence now (convex
// lib/problemEvidence.problemEvidence), not the count frozen when the card was built.
// When a re-judge or a merge leaves the problem with no findings, nothing is
// behind the change: the card says so and recommends Drop, naming where the
// evidence went. /trial's list and pane and the problem page read it here.
import { BASE_CHECK, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { JUDGE_FIX_MIN_CONTROLS } from "@codecast/shared/contracts/judgeFix";
import type { TrialCardRow, TrialCited, TrialEvidence, TrialWithdrawn } from "../hooks/useSyncTrial";

/** Whether the problem behind a card has no findings left. Unknown (an older backend) is not gone. */
export const evidenceGone = (e: TrialEvidence | null | undefined): boolean => !!e && e.findings === 0;

/** How one finding left its problem, in a few words: "judged again: not a defect", "moved to ct-59517". */
export function fateWords(g: TrialWithdrawn): string {
  if (g.to) return `moved to ${g.to}`;
  if (g.fate === "rejudged") return "judged again: not a defect";
  if (g.fate === "duplicate") return "a copy of a finding on a closed problem";
  if (g.fate === "found_wrong") return "found wrong by the fix run's proof";
  if (g.fate === "history") return "from before the fix";
  if (g.fate === "coaching") return "handed to coaching";
  if (g.fate === "closed") return "closed with the problem";
  return "withdrawn";
}

/** Where the evidence went, in a few words: "moved to ct-59425" or "none held when judged again". */
export function goneWhere(e: TrialEvidence): string {
  if (e.moved_to.length) return `moved to ${e.moved_to.join(", ")}`;
  const fates = new Set((e.gone ?? []).map((g) => g.fate));
  if (fates.size === 1 && fates.has("found_wrong")) return "found wrong by the fix run's proof";
  if (fates.size === 1 && fates.has("duplicate")) return "copies of findings on closed problems";
  if (fates.size === 1 && fates.has("history")) return "all from before the fix";
  if (fates.size === 1 && fates.has("coaching")) return "handed to coaching";
  if (fates.has("rejudged") || e.withdrawn) return "none held when judged again";
  return "no findings";
}

/**
 * The card as a person should read it now: with its evidence gone, Drop is
 * recommended for that reason alone (`recommend.source` "evidence"), so a
 * surface says the why and not the checks the author's verdict rested on.
 */
export function cardAsRead(c: Pick<TrialCardRow, "card" | "evidence"> & Partial<Pick<TrialCardRow, "coverage">>): ChangeCard | undefined {
  const card = c.card;
  // Every conversation the author said the change reaches has left the problem since: whatever its proof showed, it
  // fixes nothing that is still a finding here, so it goes back to be rebuilt on the ones left.
  if (card && c.coverage && c.coverage.covered === 0 && card.recommend?.verdict === "ship" && !(c.evidence && evidenceGone(c.evidence))) {
    const left = c.coverage.other + c.coverage.fresh;
    return {
      ...card,
      recommend: { verdict: "revise", why: `None of the conversations this change was built for is still a finding; ${left} ${left === 1 ? "conversation is" : "conversations are"} left, none covered.`, source: "evidence" },
      ask: "Rebuild it on the conversations still behind the problem, or drop it if none of them is this miss.",
    };
  }
  if (!card || !c.evidence || !evidenceGone(c.evidence)) return card;
  const why = c.evidence.moved_to.length
    ? `no conversation is behind this problem now; its findings sit on ${c.evidence.moved_to.join(", ")}.`
    : `no conversation is behind this problem now; ${goneWhere(c.evidence)}.`;
  return { ...card, recommend: { verdict: "drop", why: why.charAt(0).toUpperCase() + why.slice(1), source: "evidence" }, ask: undefined };
}

/** Where a waiting card belongs on /trial: the executive's queue, our own review tooling, held by the pipeline, a rebuild running now, or nothing left. */
export type TrialLane = "waiting" | "tooling" | "held" | "running" | "empty";

/** Why the pipeline holds a card back from a person: it is rebuilding on main, one conversation is too thin for a change
 *  that reaches many (a proposal or a built change), a proposal gate has no proposal card yet, a proposal's count was taken
 *  before its problem was regrouped, its author recommends waiting for evidence, or a judge fix was measured on too few kept
 *  findings to show it keeps them. Evals a change owes hold nothing: the trial never runs them, so they are a fact on the card. */
export type TrialHold = { kind: "rebuilding" | "stale" | "stale_gate" | "one_case" | "uncarded" | "remeasure" | "recase" | "wait" | "controls"; words: string };

/** The proposal's own case as it stands now; undefined when the card cites none or the backend says nothing. */
export const proposalCase = (c: Pick<TrialCardRow, "proposal" | "cited">): TrialCited | undefined =>
  c.proposal?.case ? c.cited?.find((x) => x.signal === c.proposal!.case!.signal) : undefined;

/** Whether the run's proof showed the miss on main; null when the card does not say (older cards). */
export const proposalProved = (c: Pick<TrialCardRow, "proposal">): boolean | null =>
  c.proposal?.proof ? c.proposal.proof.outcome === "red" : null;

/** The run's own count of the miss in the product's record, when it found any: evidence that outlives the problem's findings. */
export const proposalMeasured = (c: Pick<TrialCardRow, "proposal">): boolean => (c.proposal?.measured?.count ?? 0) > 0;

/** A proposal with no live case, no other finding left on its problem, no count of its own and no proof of the miss: nothing stands behind it. */
export function proposalUnfounded(c: Pick<TrialCardRow, "proposal" | "cited"> & Partial<Pick<TrialCardRow, "evidence">>): string | null {
  if (!c.proposal) return null;
  const cs = proposalCase(c);
  const live = cs ? cs.state === "live" : !c.proposal.case ? false : true;
  if (live || proposalProved(c) || proposalMeasured(c) || (c.evidence?.findings ?? 0) > 0) return null;
  return proposalProved(c) === false ? "No case on file; the proof did not show the miss" : "No case on file; the proof never finished";
}

export function trialHold(c: Pick<TrialCardRow, "status" | "card" | "proposal" | "evidence" | "rebuilding"> & Partial<Pick<TrialCardRow, "coverage" | "evals_owed" | "judge_fix" | "kind" | "decision" | "tooling" | "regrouped" | "cited" | "stale_gate">>): TrialHold | null {
  if (c.rebuilding) return { kind: "rebuilding", words: `Rebuilding on main${c.rebuilding.node ? ` · ${c.rebuilding.node.replace(/_/g, " ")}` : ""}` };
  if (c.status !== "waiting") return null;
  // The line dropped the step this card waits at: no answer has anywhere to go until its run is picked up at a step the line still has.
  if (c.stale_gate) return { kind: "stale_gate", words: "Its step left the line" };
  if (c.judge_fix?.ab.verdict === "few_controls") return { kind: "controls", words: `${c.judge_fix.ab.controls.moments} of ${JUDGE_FIX_MIN_CONTROLS} kept-finding moments · rerun when there are more` };
  // A branch behind main is not being rebuilt until someone sends it back (cast line trial rebuild): say what it is.
  const base = c.card?.checks.find((k) => k.name === BASE_CHECK && !k.ok);
  if (base) return { kind: "stale", words: "Behind main · rebuild before asking" };
  const card = cardAsRead(c);
  // A gate with nothing to read but its station's markdown is not a card yet: it waits for its words station, never on a person.
  if (c.kind === "gate" && !card && !c.proposal && !c.judge_fix && !c.decision && !c.tooling) return { kind: "uncarded", words: "No proposal card yet · re-ask to make one" };
  // A count taken before findings joined the problem measures a different set: it is taken again before anyone reads it.
  if (c.proposal?.measured && c.regrouped) return { kind: "remeasure", words: "Regrouped after its count · re-ask to remeasure" };
  // Its case left the problem while other findings stay: the card shows no conversation that still has the miss.
  const cs = c.proposal && c.cited ? proposalCase(c as Pick<TrialCardRow, "proposal" | "cited">) : undefined;
  if (cs && cs.state !== "live" && !c.tooling && (c.evidence?.findings ?? 0) > 0) return { kind: "recase", words: `Its case ${cs.signal} left the problem · re-ask for a live one` };
  // One conversation is too thin for anything riskier than Low, a built change as much as a proposal.
  const risk = c.proposal?.risk ?? card?.risk;
  // A count the run took itself of more than one case is more than one conversation's worth.
  if (risk && risk.class !== "low" && !evidenceGone(c.evidence) && (c.evidence?.conversations ?? 0) <= 1 && (c.proposal?.measured?.count ?? 0) <= 1) return { kind: "one_case", words: "1 conversation · waits for a second" };
  // Its own author recommends waiting: the dispatcher first sends it back to gather what it can (lineTrial.gatherDue), so it never asks a person to wait.
  if (c.proposal?.recommend?.verdict === "wait") return { kind: "wait", words: "Waits for more evidence" };
  return null;
}

export function trialLane(c: TrialCardRow): TrialLane | null {
  if (c.rebuilding) return "running";
  if (c.status !== "waiting") return null;
  if ((evidenceGone(c.evidence) && !proposalMeasured(c)) || proposalUnfounded(c)) return "empty";
  // A judge fix is our tooling's card, but one measured on too few controls waits before anyone reads it.
  if (c.judge_fix?.ab.verdict === "few_controls") return "held";
  if (c.tooling) return "tooling";
  if (trialHold(c)) return "held";
  return "waiting";
}

/** The one /trial tab a card is counted under, so the tabs add up to All: its lane while it waits or rebuilds, else answered or closed. */
export type TrialCardTab = TrialLane | "answered" | "closed";
export const trialCardTab = (c: TrialCardRow): TrialCardTab => trialLane(c) ?? (c.status === "answered" ? "answered" : "closed");

/** Cards gathered by their problem: one group per problem, its newest card first and leading, groups newest first. */
export function cardsByProblem<T extends Pick<TrialCardRow, "task_id" | "created_at">>(cards: T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const c of cards) (by.get(c.task_id) ?? by.set(c.task_id, []).get(c.task_id)!).push(c);
  return [...by.values()].map((g) => g.sort((a, b) => b.created_at - a.created_at)).sort((a, b) => b[0].created_at - a[0].created_at);
}

/** Why a card in the Nothing left lane is dropped, in a row's few words: its lane decides the mark, never the author's verdict. */
export function emptyWords(c: TrialCardRow): string {
  return proposalUnfounded(c) ?? "Drop: evidence gone";
}

/**
 * A proposal as a person should read it now: with no finding left on its
 * problem and no count of its own, nothing stands behind building it, so the
 * recommendation is Not now for that reason alone, whatever the author wrote.
 */
export function proposalAsRead<P extends { recommend?: { verdict: "build" | "revise" | "wait"; why: string }; measured?: { count: number } | null }>(proposal: P | undefined, evidence: TrialEvidence | null | undefined): P | undefined {
  if (!proposal || !evidence || !evidenceGone(evidence) || (proposal.measured?.count ?? 0) > 0) return proposal;
  const why = evidence.moved_to.length ? `No conversation is behind this problem now; its findings sit on ${evidence.moved_to.join(", ")}.` : `No conversation is behind this problem now; ${goneWhere(evidence)}.`;
  return { ...proposal, recommend: { verdict: "wait", why } };
}

/** "ex-agentwatch-trial-20" as the short id a person reads: "ex-20". */
export const ruleId = (id: string) => id.replace(/^ex-.*-(\d+)$/, "ex-$1");

/** A prove.json prior art line as the problem it builds on and what the proof saw with it: "ct-59425", "still red with it applied (3 of 6 draws)". */
export function priorArt(text: string | undefined): { ref: string; saw: string } | null {
  const ref = text ? /\b(ct-\d+)\b/.exec(text)?.[1] : undefined;
  if (!ref) return null;
  const saw = text!.includes(":") ? text!.slice(text!.indexOf(":") + 1).trim() : "";
  return { ref, saw };
}

/**
 * How much of the problem a change reaches, counted once for every surface of
 * a card (the Reaches fact, the recommendation, the lead, the page the session
 * published): the pair the card was asked with, which the session's own words
 * and page state, so no surface says another figure. What moved on the problem
 * since is said beside it, never folded in: `fresh` conversations that joined
 * and were never read, `gone` findings that left.
 */
export type TrialReach = { covered: number; of: number; fresh: number; gone: number };
export function trialReach(c: Pick<TrialCardRow, "card"> & Partial<Pick<TrialCardRow, "coverage">>): TrialReach | null {
  const asked = c.card?.reach;
  if (!asked) return null;
  return { covered: asked.conversations, of: asked.of, fresh: c.coverage?.fresh ?? 0, gone: c.coverage?.gone ?? 0 };
}

/** What moved on the problem since the card was asked, in a few words ("1 new, 1 left"); empty when nothing did. */
export function reachSince(r: TrialReach): string {
  const parts = [r.fresh ? `${r.fresh} new` : "", r.gone ? `${r.gone} left` : ""].filter(Boolean);
  return parts.join(", ");
}

const VIEW_FENCE = /```view\s*\n\s*([a-z][a-z0-9-]*:[a-z][\w.-]*\/[^\s`]+)\s*\n```/g;
const QUOTED_LINE = /^(>\s*)["\u201c](.*)["\u201d]\s*$/;

/**
 * A session's decision text as the card shows it: a product reference its
 * author fenced (```view over a bare `union:conversation/<id>@<time>`) reads
 * as a link to that conversation in the sentence, never as a line of ids; a
 * blockquote that is one quotation drops its own quote marks, since the
 * quote block already says it is one. Its figures are left as written: they
 * are the card's own (trialReach).
 */
export function cardProse(md: string, _card?: unknown): string {
  return md
    .replace(VIEW_FENCE, (_m, ref: string) => `The conversation: ${ref}`)
    .split("\n")
    .map((line) => { const q = QUOTED_LINE.exec(line); return q && !/["\u201c\u201d]/.test(q[2]) ? `${q[1]}${q[2]}` : line; })
    .join("\n");
}

/** How a card's working time reads: "41 min", "2 h 10 min". */
export function workTime(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/**
 * Another open card on the same code, as a reader needs it: the card's own
 * line on how the two meet with the other card's id and any file reference
 * taken out (the id is already the link), and whether that line concludes
 * they cannot conflict, which is a muted note rather than a warning.
 */
export function overlapNote(o: { card: string; title: string; how?: string }): { text: string; clear: boolean } {
  const how = (o.how ?? "").trim();
  const text = (how || o.title)
    .replace(new RegExp(`^${o.card}\\b[\\s:,.-]*`, "i"), "")
    .replace(/\s*(?:\b(?:in|at|on)\s+)?\(?\b[\w./-]+\.(?:ts|tsx|js|njk|md|py|json):\d+(?:-\d+)?\)?/g, "")
    .replace(/\s+([.,;])/g, "$1")
    .trim()
    .replace(/^\w/, (ch) => ch.toUpperCase());
  const clear = /\b(cannot|can't|do not|don't|never|no)\s+(conflict|collide|overlap)|\bno conflict\b|\bdo not compete\b|\bindependent\b/i.test(how);
  return { text, clear };
}
