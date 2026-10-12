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
import { RISK_CLASSES, countSentences, overturnsErrors, type CardOverturns, type RiskClass } from "./changeCard";
import { receivedWords } from "./moments";

export interface ProposalCase {
  /** The finding (sg-N) the case comes from. */
  signal: string;
  /** The contact's situation in a few words (labelled "Situation" on the card). */
  asked: string;
  /** One line, verbatim from the real moment, that a contact or a caller received and that shows the miss; a short bracketed correction may mend a transcription error. */
  quote: string;
  /** What the quoted words get wrong for this contact, in a few words. */
  missing?: string;
  /** Who received the quoted words: a contact or member, or Union's own people (a caller's tip or coaching note). Absent reads "contact". */
  to?: ProposalAudience;
  /**
   * The moment that carries the cause, timestamped, when the cause is about
   * when or what something was shown during a call (a tip on a caller's
   * screen): the contact's words, the tip on screen then, the caller's next
   * line. Two to five beats, in call order.
   */
  beats?: ProposalBeat[];
}

/** Who speaks or shows in a call beat: the contact, the caller, or the tip on the caller's screen. */
export const BEAT_WHO = ["contact", "caller", "tip"] as const;
export type ProposalBeat = { at: string; who: (typeof BEAT_WHO)[number]; text: string };

/** Another open card whose fix changes the same code, and how the two meet, in one line ("tc-41 wins on an intro: ..."). */
export type ProposalAlongside = { card: string; line: string };

/** Who a proposal's quoted words reached: the card titles the case by it. */
export const PROPOSAL_AUDIENCES = ["contact", "member", "caller", "team"] as const;
export type ProposalAudience = (typeof PROPOSAL_AUDIENCES)[number];

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

/**
 * A proposal gate's answers, the same on every proposal card whatever graph
 * its run started on: a run paused for hours keeps the gate labels it was
 * given (tc-43 asked Approve / Revise / Drop), so a card reads them from here
 * by key.
 */
export const PROPOSAL_OPTIONS: ReadonlyArray<{ key: string; label: string; description: string }> = [
  { key: "A", label: "Build it", description: "The fix gets built and comes back as a change card to ship or not; in the trial nothing ships" },
  { key: "R", label: "Revise", description: "Your note goes back to the proposal, which is asked again; nothing is built yet" },
  { key: "D", label: "Not now", description: "Nothing is built; the problem stays open with this proposal on it" },
];

/** A proposal gate's stored options in the shared words, by key; a key the set does not name keeps its own. */
export function proposalOptions<T extends { key: string; label: string; description?: string }>(options: T[]): T[] {
  return options.map((o) => {
    const p = PROPOSAL_OPTIONS.find((x) => x.key === o.key.toUpperCase());
    return p ? { ...o, label: p.label, description: p.description } : o;
  });
}

/** How a measured count was made: a replay of real cases on main, or a read of production records. */
export const MEASURE_METHODS = ["replay", "production-read"] as const;
export type MeasureMethod = (typeof MEASURE_METHODS)[number];

/**
 * The miss counted beyond the problem's findings, by the run itself: `count`
 * of `of` show it, over `window`, by `method`. A replay that also ran the
 * proposed change says how many still show it with the change (`after`).
 * A count above 0 is evidence that outlives the problem's findings (web
 * lib/trialEvidence.ts reads it for the empty lane and the one-case hold).
 */
export interface ProposalMeasured {
  count: number;
  of: number;
  /** What was counted over, in a few words: "60 days of intro sends", "32 regulated calls". */
  window: string;
  method: MeasureMethod;
  after?: number;
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
  /** The answer the author recommends and why, in one sentence. A line run's card always carries it; absent only on older cards. */
  recommend?: { verdict: ProposalVerdict; why: string };
  /** The run's own count of the miss in the product's record; absent when it counted nothing. A proposal with a count above 0 stands on it even when the problem's findings are judged away. */
  measured?: ProposalMeasured | null;
  /** The earlier call this proposal reverses (an earlier proposal on the same problem, tc-N, or a decision or task), shown as "Changes an earlier call". */
  overturns?: CardOverturns;
  /** The project expectation the miss breaks, by id, when that line's own words describe it; null when none does. Absent on older cards, which show the case finding's subject. */
  rule?: string | null;
  /** What the run's proof station showed. A line run's card always carries it (`cast card proposal --prove`); absent only on older cards. */
  proof?: ProposalProof;
  /** Each other waiting card whose fix changes the same code, with how the two interact; `cast card proposal --task` refuses a card that leaves one out. */
  alongside?: ProposalAlongside[];
}

export type ProposalCardValidation = { ok: true; card: ProposalCard } | { ok: false; errors: string[] };

const MAX_QUESTION = 110;
const MAX_SENTENCE = 260;
const MAX_FEW_WORDS = 90;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export const isProposalCard = (x: unknown): boolean => isObj(x) && x.kind === "proposal";

/**
 * Every problem with a proposal card, each naming its field, so the node that
 * wrote it can fix exactly that. `line`: the card a line run is about to show
 * (`cast card proposal`, a recard), which must carry its recommendation and
 * its proof; cards stored before both existed still read.
 */
export function validateProposalCard(input: unknown, opts: { line?: boolean } = {}): ProposalCardValidation {
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
      // A case is shown by the words someone received and what they get wrong: with either empty, there is nothing to read.
      if (text("case.quote", c.case.quote, 600) && c.case.quote.trim() && receivedWords(c.case.quote) === "") err("case.quote", "holds only codecast's marks; quote a line someone received, or set case to null");
      text("case.missing", c.case.missing, MAX_FEW_WORDS);
      if (c.case.to !== undefined && !(PROPOSAL_AUDIENCES as readonly unknown[]).includes(c.case.to)) err("case.to", `expected one of ${PROPOSAL_AUDIENCES.join(" | ")}`);
      if (c.case.beats !== undefined) {
        const b = c.case.beats;
        if (!Array.isArray(b) || b.length < 2 || b.length > 5) err("case.beats", "expected 2 to 5 beats [{ at, who, text }], in call order");
        else b.forEach((x, i) => {
          if (!isObj(x)) return err(`case.beats[${i}]`, "expected { at, who, text }");
          if (typeof x.at !== "string" || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(x.at.trim())) err(`case.beats[${i}].at`, 'expected the call time as "m:ss"');
          if (!(BEAT_WHO as readonly unknown[]).includes(x.who)) err(`case.beats[${i}].who`, `expected one of ${BEAT_WHO.join(" | ")}`);
          text(`case.beats[${i}].text`, x.text, 240);
        });
      }
    }
  }
  if (!isObj(c.risk)) err("risk", "expected { class, reason }");
  else {
    if (!(RISK_CLASSES as readonly unknown[]).includes(c.risk.class)) err("risk.class", `expected one of ${RISK_CLASSES.join(" | ")}`);
    text("risk.reason", c.risk.reason, MAX_FEW_WORDS);
  }
  if (c.recommend === undefined && opts.line) err("recommend", "required: { verdict: build | revise | wait, why }, the answer you recommend and why, with the counts the run measured");
  if (c.recommend !== undefined) {
    if (!isObj(c.recommend)) err("recommend", `expected { verdict, why }`);
    else {
      if (!(PROPOSAL_VERDICTS as readonly unknown[]).includes(c.recommend.verdict)) err("recommend.verdict", `expected one of ${PROPOSAL_VERDICTS.join(" | ")}`);
      sentence("recommend.why", c.recommend.why);
    }
  }
  if (c.rule !== undefined && c.rule !== null && (typeof c.rule !== "string" || !/^ex-[\w-]+$/.test(c.rule))) err("rule", "expected an expectation id (ex-...) or null");
  if (c.proof === undefined && opts.line) err("proof", "required: the proof station's rung and outcome (cast card proposal --prove <prove.json>)");
  if (c.proof !== undefined && (!isObj(c.proof) || typeof c.proof.rung !== "string" || typeof c.proof.outcome !== "string")) err("proof", "expected { rung, outcome, prior_art? }");
  if (c.measured !== undefined && c.measured !== null) {
    const m = c.measured;
    if (!isObj(m)) err("measured", "expected { count, of, window, method } or null");
    else {
      const whole = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
      if (!whole(m.count)) err("measured.count", "expected a whole number");
      if (!whole(m.of) || (m.of as number) < 1) err("measured.of", "expected a whole number above 0");
      else if (whole(m.count) && (m.count as number) > (m.of as number)) err("measured.count", `${m.count} is more than of (${m.of})`);
      text("measured.window", m.window, MAX_FEW_WORDS);
      if (!(MEASURE_METHODS as readonly unknown[]).includes(m.method)) err("measured.method", `expected one of ${MEASURE_METHODS.join(" | ")}`);
      // A null after is no after: the author wrote the key with nothing to put in it.
      if (m.after === null) delete m.after;
      if (m.after !== undefined && (!whole(m.after) || (whole(m.of) && (m.after as number) > (m.of as number)))) err("measured.after", "expected a whole number no more than of");
      if (m.after !== undefined && m.method !== "replay") err("measured.after", "only a replay runs the change");
    }
  }
  // One count feeds the tile and the recommendation: a count the why builds on lives in measured, where the card shows it.
  if (opts.line && isObj(c.recommend) && typeof c.recommend.why === "string") {
    const why = c.recommend.why;
    const m = isObj(c.measured) ? c.measured : null;
    const counts = why.match(/(?<!\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s)\b\d[\d,]*\b(?!\s*(?:%|seconds?|minutes?|hours?|days?|weeks?|months?|s\b|am\b|pm\b))/gi) ?? [];
    if (!m && c.recommend.verdict === "build" && counts.length) err("recommend.why", `cites a count (${counts[0]}) that measured does not carry; put it in measured { count, of, window, method } so the card shows it, or leave the number out`);
    const pair = /\b(\d[\d,]*) of (?:the )?(\d[\d,]*)\b/.exec(why);
    if (m && pair && (Number(pair[1].replace(/,/g, "")) !== m.count || Number(pair[2].replace(/,/g, "")) !== m.of)) err("recommend.why", `says ${pair[1]} of ${pair[2]} while measured says ${m.count} of ${m.of}; one count feeds both`);
  }
  if (c.alongside !== undefined) {
    if (!Array.isArray(c.alongside)) err("alongside", "expected [{ card, line }]");
    else c.alongside.forEach((a, i) => {
      if (!isObj(a) || typeof a.card !== "string" || !/^tc-\d+$/.test(a.card)) err(`alongside[${i}].card`, "expected a trial card id (tc-N)");
      else text(`alongside[${i}].line`, a.line, 200);
    });
  }
  if (c.overturns !== undefined) errors.push(...overturnsErrors(c.overturns, /^(ct|sd|ds|tc)-\d+$/));
  return errors.length ? { ok: false, errors } : { ok: true, card: input as unknown as ProposalCard };
}

const LINES_NEAR = 30;
/** "backend/src/lib/x/matching.njk:319-334" as a path and its first line. */
export const whereParts = (w: string) => {
  const m = /^(.*?):(\d+)(?:-\d+)?$/.exec(w.trim());
  return m ? { file: m[1], line: Number(m[2]) } : { file: w.trim(), line: null as number | null };
};
/** Whether two places name the same file: one path ends with the other (checkouts root them differently). */
export const sameFile = (a: string, b: string) => {
  const fx = whereParts(a).file.replace(/^\.?\//, ""), fy = whereParts(b).file.replace(/^\.?\//, "");
  return fx === fy || fx.endsWith(`/${fy}`) || fy.endsWith(`/${fx}`);
};
/** Whether two places name the same code: the same file and lines within LINES_NEAR. */
export function sameCode(a: string, b: string): boolean {
  if (!sameFile(a, b)) return false;
  const x = whereParts(a), y = whereParts(b);
  return x.line === null || y.line === null || Math.abs(x.line - y.line) <= LINES_NEAR;
}

/** Waiting cards whose fix changes the same code as `where` and that the card's `alongside` does not say how it meets. */
export function alongsideMissing(card: { alongside?: ProposalAlongside[] }, where: string[], others: Array<{ card: string; where: string[] }>): string[] {
  const said = new Set((card.alongside ?? []).map((a) => a.card));
  return others.filter((o) => !said.has(o.card) && where.some((a) => o.where.some((b) => sameCode(a, b)))).map((o) => o.card);
}
