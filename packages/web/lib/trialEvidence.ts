// A trial card read against its problem's evidence now (convex
// lineTrial.problemEvidence), not the count frozen when the card was built.
// When a re-judge or a merge leaves the problem with no findings, nothing is
// behind the change: the card says so and recommends Drop, naming where the
// evidence went. /trial's list and pane and the problem page read it here.
import { BASE_CHECK, evalsOwed, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import type { TrialCardRow, TrialCited, TrialEvidence, TrialWithdrawn } from "../hooks/useSyncTrial";

/** Whether the problem behind a card has no findings left. Unknown (an older backend) is not gone. */
export const evidenceGone = (e: TrialEvidence | null | undefined): boolean => !!e && e.findings === 0;

/** How one finding left its problem, in a few words: "judged again: not a defect", "moved to ct-59517". */
export function fateWords(g: TrialWithdrawn): string {
  if (g.to) return `moved to ${g.to}`;
  if (g.fate === "rejudged") return "judged again: not a defect";
  if (g.fate === "duplicate") return "a copy of a finding on a closed problem";
  if (g.fate === "found_wrong") return "found wrong by the fix run's proof";
  return "withdrawn";
}

/** Where the evidence went, in a few words: "moved to ct-59425" or "none held when judged again". */
export function goneWhere(e: TrialEvidence): string {
  if (e.moved_to.length) return `moved to ${e.moved_to.join(", ")}`;
  const fates = new Set((e.gone ?? []).map((g) => g.fate));
  if (fates.size === 1 && fates.has("found_wrong")) return "found wrong by the fix run's proof";
  if (fates.size === 1 && fates.has("duplicate")) return "copies of findings on closed problems";
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
  if (card && c.coverage && c.coverage.covered === 0 && card.recommend.verdict === "ship" && !(c.evidence && evidenceGone(c.evidence))) {
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

/** Where a waiting card belongs on /trial: the executive's queue, our own review tooling, held by the pipeline, or nothing left. */
export type TrialLane = "waiting" | "tooling" | "held" | "empty";

/** Why the pipeline holds a card back from a person: it is rebuilding on main, one conversation is too thin for a change
 *  that reaches many, or it recommends Ship but owes evals the trial never runs, so the person could not follow it. */
export type TrialHold = { kind: "rebuilding" | "one_case" | "evals"; words: string };

/** The proposal's own case as it stands now; undefined when the card cites none or the backend says nothing. */
export const proposalCase = (c: Pick<TrialCardRow, "proposal" | "cited">): TrialCited | undefined =>
  c.proposal?.case ? c.cited?.find((x) => x.signal === c.proposal!.case!.signal) : undefined;

/** Whether the run's proof showed the miss on main; null when the card does not say (older cards). */
export const proposalProved = (c: Pick<TrialCardRow, "proposal">): boolean | null =>
  c.proposal?.proof ? c.proposal.proof.outcome === "red" : null;

/** A proposal with no live case and no proof of the miss: nothing stands behind it. */
export function proposalUnfounded(c: Pick<TrialCardRow, "proposal" | "cited">): string | null {
  if (!c.proposal) return null;
  const cs = proposalCase(c);
  const live = cs ? cs.state === "live" : !c.proposal.case ? false : true;
  if (live || proposalProved(c)) return null;
  return proposalProved(c) === false ? "No case on file; the proof did not show the miss" : "No case on file; the proof never finished";
}

export function trialHold(c: Pick<TrialCardRow, "status" | "card" | "proposal" | "evidence" | "rebuilding"> & Partial<Pick<TrialCardRow, "coverage" | "evals_owed">>): TrialHold | null {
  if (c.rebuilding) return { kind: "rebuilding", words: `Rebuilding on main${c.rebuilding.node ? ` · ${c.rebuilding.node.replace(/_/g, " ")}` : ""}` };
  if (c.status !== "waiting") return null;
  const base = c.card?.checks.find((k) => k.name === BASE_CHECK && !k.ok);
  if (base) return { kind: "rebuilding", words: "Rebuilding on main" };
  const card = cardAsRead(c);
  if (card?.recommend.verdict === "ship" && (c.evals_owed?.length || evalsOwed(card))) {
    const n = c.evals_owed?.length || 1;
    return { kind: "evals", words: `${n} ${n === 1 ? "eval" : "evals"} owed · not run in the trial` };
  }
  if (c.proposal && c.proposal.risk.class !== "low" && (c.evidence?.conversations ?? 0) <= 1) return { kind: "one_case", words: "1 conversation · waits for a second" };
  return null;
}

export function trialLane(c: TrialCardRow): TrialLane | null {
  if (c.rebuilding) return "held";
  if (c.status !== "waiting") return null;
  if (evidenceGone(c.evidence) || proposalUnfounded(c)) return "empty";
  if (c.tooling) return "tooling";
  if (trialHold(c)) return "held";
  return "waiting";
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
