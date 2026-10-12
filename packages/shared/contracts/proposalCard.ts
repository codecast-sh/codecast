// The proposal card: the first decision a person sees for a fix, before any
// of it is built (the line's proposal gate). It carries the change card's
// building blocks for a change not yet made: what a contact gets today and
// after the proposed change, the cause in one line with where it lives, one
// real conversation that shows it, and what is risked. The proposal's full
// document stays beside it for whoever wants to read it.
//
// A words node writes the fields (agentwatch-trial/proposal-words.md), `cast
// card proposal` validates them into a file, and a gate's card attribute
// names that file (cardFile.ts readGateCard).
import { RISK_CLASSES, countSentences, type RiskClass } from "./changeCard";

export interface ProposalCase {
  /** The finding (sg-N) the case comes from. */
  signal: string;
  /** The contact's situation in a few words (labelled "Situation" on the card). */
  asked: string;
  /** The words Union sent that show the miss; empty when no sent words show it. */
  quote: string;
  /** What the quoted words leave out or get wrong, in a few words, when the quote alone does not show it. */
  missing?: string;
}

/** The answer the proposal's author recommends, keyed like the gate's options: Build it, Revise, Not now. */
export const PROPOSAL_VERDICTS = ["build", "revise", "wait"] as const;
export type ProposalVerdict = (typeof PROPOSAL_VERDICTS)[number];
/** The gate option each verdict answers (agentwatch-trial.cast proposal_gate: [A] Build it, [R] Revise, [D] Not now). */
export const PROPOSAL_VERDICT_KEY: Record<ProposalVerdict, string> = { build: "A", revise: "R", wait: "D" };

/** What the run's proof station showed, copied from its prove.json by `cast card proposal --prove`: code-written, never the author's. */
export interface ProposalProof {
  /** "replay": a real conversation's step replayed on main; "test": a code test; anything else as the station named it. */
  rung: string;
  /** "red": main still shows the miss; "infeasible": no check could show it. */
  outcome: string;
  /** An unmerged fix elsewhere the proof ran against, as the station named it ("ct-59425 origin/... 1eadcef23a: still red with it applied"). */
  prior_art?: string;
}

export interface ProposalCard {
  kind: "proposal";
  /** One yes/no question: the fix, in plain words. */
  question: string;
  /** What a contact gets today, one sentence. */
  today: string;
  /** What they would get after the proposed change, one sentence. */
  after: string;
  /** The cause in one line, and where it lives (file:line). */
  cause: { line: string; where: string[] };
  /** One real conversation that shows the miss, or null when none does. */
  case: ProposalCase | null;
  risk: { class: RiskClass; reason: string };
  /** The answer the author recommends and why, in one sentence. Absent on older cards. */
  recommend?: { verdict: ProposalVerdict; why: string };
  proof?: ProposalProof;
}

export type ProposalCardValidation = { ok: true; card: ProposalCard } | { ok: false; errors: string[] };

const MAX_QUESTION = 110;
const MAX_SENTENCE = 260;
const MAX_FEW_WORDS = 90;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export const isProposalCard = (x: unknown): boolean => isObj(x) && x.kind === "proposal";

/** Every problem with a proposal card, each naming its field, so the node that wrote it can fix exactly that. */
export function validateProposalCard(input: unknown): ProposalCardValidation {
  const errors: string[] = [];
  const err = (p: string, m: string) => errors.push(`${p}: ${m}`);
  if (!isObj(input)) return { ok: false, errors: ["proposal: expected an object"] };
  const c = input;
  if (c.kind !== "proposal") err("kind", 'expected "proposal"');
  const text = (p: string, v: unknown, max: number, required = true): v is string => {
    if (typeof v !== "string") { err(p, "expected a string"); return false; }
    if (required && !v.trim()) err(p, "is empty");
    if (v.length > max) err(p, `${v.length} characters; keep it under ${max}`);
    return true;
  };
  const sentence = (p: string, v: unknown) => {
    if (text(p, v, MAX_SENTENCE) && v.trim() && countSentences(v) > 1) err(p, "one sentence");
  };
  if (text("question", c.question, MAX_QUESTION)) {
    if (!/\?\s*$/.test(c.question)) err("question", "ends with a question mark");
    if ((c.question.match(/\?/g) ?? []).length > 1 || /\band should\b|,\s*(build|ship) this fix\?/i.test(c.question)) err("question", "one question, not two");
  }
  sentence("today", c.today);
  sentence("after", c.after);
  if (!isObj(c.cause)) err("cause", "expected { line, where }");
  else {
    sentence("cause.line", c.cause.line);
    if (!Array.isArray(c.cause.where) || c.cause.where.some((w) => typeof w !== "string")) err("cause.where", "expected file:line strings");
    else if (!c.cause.where.length) err("cause.where", "names at least one file:line");
  }
  if (c.case !== null) {
    if (!isObj(c.case)) err("case", "expected { signal, asked, quote } or null");
    else {
      if (typeof c.case.signal !== "string" || !/^sg-\d+$/.test(c.case.signal)) err("case.signal", "expected a finding id (sg-N)");
      text("case.asked", c.case.asked, MAX_FEW_WORDS);
      text("case.quote", c.case.quote, 600, false);
      if (c.case.missing !== undefined) text("case.missing", c.case.missing, MAX_FEW_WORDS, false);
    }
  }
  if (!isObj(c.risk)) err("risk", "expected { class, reason }");
  else {
    if (!(RISK_CLASSES as readonly unknown[]).includes(c.risk.class)) err("risk.class", `expected one of ${RISK_CLASSES.join(" | ")}`);
    text("risk.reason", c.risk.reason, MAX_FEW_WORDS);
  }
  if (c.recommend !== undefined) {
    if (!isObj(c.recommend)) err("recommend", `expected { verdict, why }`);
    else {
      if (!(PROPOSAL_VERDICTS as readonly unknown[]).includes(c.recommend.verdict)) err("recommend.verdict", `expected one of ${PROPOSAL_VERDICTS.join(" | ")}`);
      sentence("recommend.why", c.recommend.why);
    }
  }
  if (c.proof !== undefined && (!isObj(c.proof) || typeof c.proof.rung !== "string" || typeof c.proof.outcome !== "string")) err("proof", "expected { rung, outcome, prior_art? }");
  return errors.length ? { ok: false, errors } : { ok: true, card: input as unknown as ProposalCard };
}
