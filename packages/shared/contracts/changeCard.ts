// The change card (docs/architecture/the-line-end-to-end.md LE10): the one
// fixed shape every run on the line ends in, whatever it changed. Code fixes,
// prompt changes, UX changes and escalations all render the same card, and the
// person answers it Ship, Revise or Drop (LE11).
//
// The model's part is the recommendation (`recommend`, its route and reason)
// and which findings the change reaches (`reach.covers`); the person reads the
// presenting session's own decision, so the card's words (`headline`,
// `context`, `wrong`, `change`) are optional. Everything else is assembled
// from what the nodes recorded: the cause and ground fields
// on the task, the eval station's eval-result.json (evalResult.ts), the
// verify, review and PR evidence on the task, and the run's cost.

import type { EarlierFix } from "./causeHistory";
import type { EvalResult, EvalSurfaceResult } from "./evalResult";

export type ChangeVerdict = "ship" | "revise" | "drop";
export type RiskClass = "low" | "review" | "plan";

export const CHANGE_VERDICTS: readonly ChangeVerdict[] = ["ship", "revise", "drop"];
export const RISK_CLASSES: readonly RiskClass[] = ["low", "review", "plan"];
export const MAX_EXAMPLES = 3;
const MAX_SENTENCE_CHARS = 360;
const MAX_HEADLINE_CHARS = 80;

export interface CardCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CardExample {
  input: string;
  before: string;
  after: string;
  note: string;
}

/** A conversation behind the cause, as the card shows it: the finding, the
 *  contact's own stated need it broke in a few words, and the words sent that
 *  show the miss (empty when no sent words show it; the finding's text stands in). */
export interface CardSeen {
  signal: string;
  /** The contact's situation in a few words (the field keeps its first name; the card labels it "Situation"). */
  asked: string;
  quote: string;
  /** What the quoted words leave out or get wrong, in a few words, when the quote alone does not show the miss. */
  missing?: string;
}
export const MAX_SEEN = 2;
const MAX_ASKED_CHARS = 90;
const MAX_RISK_CHARS = 90;
const MAX_NEXT_CHARS = 160;

/** How many of the problem's conversations the change reaches, as its author counted them. */
export interface CardReach {
  conversations: number;
  of: number;
  /** The findings (sg-N) the change reaches, as the author read them. Absent on older cards. */
  covers?: string[];
  /** The problem's live findings when the card was built, recorded by `cast card build`, so a reader can tell a finding that arrived later from one the author read and left out. */
  read?: string[];
}

/** An earlier call this change reverses: a decision or task someone made, carried forward from the approved proposal so the person deciding sees what they are undoing. */
export interface CardOverturns {
  /** The decision or task it reverses: "ct-53874", "sd-412". */
  ref: string;
  /** Who made that call: a person's name or role. */
  by: string;
  /** What that call settled, in a few words. */
  what: string;
  /** Why it should change now, in one short clause; absent on older cards. */
  why?: string;
}
const MAX_OVERTURNS_CHARS = 140;

/** Every problem with an `overturns` field, each naming its path. `ref` takes the ids a reversed call can carry (a proposal card also reverses an earlier trial card, tc-N). */
export function overturnsErrors(o: unknown, ref = /^(ct|sd|ds)-\d+$/): string[] {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return [`overturns: expected { ref, by, what, why? }`];
  const x = o as Record<string, unknown>;
  const out: string[] = [];
  const text = (k: string) => {
    if (typeof x[k] !== "string" || !(x[k] as string).trim()) out.push(`overturns.${k}: expected a non-empty string`);
  };
  text("ref");
  if (typeof x.ref === "string" && x.ref.trim() && !ref.test(x.ref.trim())) out.push(`overturns.ref: "${x.ref}"; the decision or task id it reverses, like ct-53874`);
  text("by");
  text("what");
  if (typeof x.what === "string" && x.what.length > MAX_OVERTURNS_CHARS) out.push(`overturns.what: ${x.what.length} characters; a few words, under ${MAX_OVERTURNS_CHARS}`);
  if (x.why !== undefined && (typeof x.why !== "string" || x.why.length > MAX_OVERTURNS_CHARS)) out.push(`overturns.why: one short clause on why that call should change, under ${MAX_OVERTURNS_CHARS} characters`);
  return out;
}

/** A change that works by sending less: what stops per week on the replay window, and what the contact hears instead, and when. */
export interface CardStops {
  per_week: number;
  /** What stops, plural noun: "emails", "intro offers", "match proposals". */
  what: string;
  next: string;
  /** What the count was taken over, in a few words ("14-day count, all contacts"), so it is not read as the problem's own conversations. */
  basis?: string;
}

export interface ChangeCard {
  cause: { task: string; title: string; signals: number; first_seen: number | null; sources: string[] };
  goal: { ref: string; name: string; why: string };
  /** The card's title in plain words, for a reader who did not follow the work. */
  headline?: string;
  /** One sentence on what the affected part of the product is and who sees it. */
  context?: string;
  /** With a Revise recommendation, the note the author suggests sending back: the Revise answer starts from it. */
  ask?: string;
  /** What is wrong and what the change does, in a fixed card's two lines. Empty when a session's own decision presents the change. */
  wrong: string;
  change: string;
  proof: { before: CardCheck[]; after: CardCheck[] };
  examples: CardExample[];
  /** The author's picks of the conversations most central to the cause, for "What contacts got today". Absent on older cards. */
  seen?: CardSeen[];
  /** How many of the problem's conversations this change reaches. Absent on older cards. */
  reach?: CardReach;
  /** Set when the change works by sending less: the volume it stops and what the contact hears next. */
  stops?: CardStops;
  /** Set when the change reverses an earlier call (a decision or a task's ruling), named on the card as "Changes an earlier call". */
  overturns?: CardOverturns;
  checks: CardCheck[];
  diff: { files: number; added: number; removed: number; pr?: string };
  risk: { class: RiskClass; reason: string };
  /** `source` "evidence": the reader turned the author's verdict to Drop because no finding is left behind the problem; the why is that, not the checks. */
  /** `confidence`: the author's chance, 0 to 100, that a person answers with this verdict; set on newer cards, so answered decisions show whether it is calibrated. */
  recommend: { verdict: ChangeVerdict; why: string; confidence?: number; source?: "evidence" };
  /** `usd`: money billed (evals, call nodes, sessions on a metered key). `list_usd`: the runs' subscription sessions at API list price, an equivalent never billed. Read through costParts. */
  cost: { tokens: number; usd: number; minutes: number; list_usd?: number };
  /** The cause's earlier shipped fixes, oldest first, so a person sees what was tried beside what is proposed now, and whether it held (line-workspace.md LW5). Absent when nothing shipped before. */
  earlier?: EarlierFix[];
}

// ── validation ───────────────────────────────────────────────────────────────

/** "5 of 19 conversations" in a card's why: the reach pair, which a reader re-reads against the problem now. */
export const REACH_IN_WHY = /\b(\d+) of (\d+) conversations\b/g;

export type ChangeCardValidation = { ok: true; card: ChangeCard } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const show = (x: unknown) => (x === undefined ? "nothing" : JSON.stringify(x)?.slice(0, 60) ?? String(x));

/** Sentence ends: a stop followed by whitespace and a capital, or the end. "e.g. this" stays one sentence. */
export function countSentences(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return (t.match(/[.!?](?=\s+[A-Z"'(]|\s*$)/g) ?? []).length || 1;
}

/**
 * Every problem with a card, each naming its path and what it found, so the
 * node that wrote it can fix exactly that field. Structural errors first, then
 * the rules the line holds a card to: proof starts red, at most three
 * examples, one or two sentences, and no Ship over a failing check.
 */
export function validateChangeCard(input: unknown): ChangeCardValidation {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  if (!isObj(input)) return { ok: false, errors: [`card: expected an object, got ${show(input)}`] };
  const c = input;

  const str = (path: string, v: unknown, required = true) => {
    if (typeof v !== "string") return err(path, `expected a string, got ${show(v)}`);
    if (required && !v.trim()) err(path, "is empty");
  };
  const count = (path: string, v: unknown) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) err(path, `expected a non-negative number, got ${show(v)}`);
  };
  const oneOf = (path: string, v: unknown, allowed: readonly string[]) => {
    if (typeof v !== "string" || !allowed.includes(v)) err(path, `expected one of ${allowed.join(" | ")}, got ${show(v)}`);
  };
  const section = (path: string, v: unknown): Record<string, unknown> | null => {
    if (isObj(v)) return v;
    err(path, `expected an object, got ${show(v)}`);
    return null;
  };
  const checks = (path: string, v: unknown): CardCheck[] => {
    if (!Array.isArray(v)) {
      err(path, `expected an array of checks, got ${show(v)}`);
      return [];
    }
    v.forEach((item, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(item)) return err(p, `expected { name, ok, detail }, got ${show(item)}`);
      str(`${p}.name`, item.name);
      if (typeof item.ok !== "boolean") err(`${p}.ok`, `expected a boolean, got ${show(item.ok)}`);
      str(`${p}.detail`, item.detail, false);
    });
    return v.filter((x): x is CardCheck => isObj(x) && typeof x.name === "string" && typeof x.ok === "boolean");
  };
  const sentences = (path: string, v: unknown) => {
    str(path, v);
    if (typeof v !== "string" || !v.trim()) return;
    const n = countSentences(v);
    if (n > 2) err(path, `${n} sentences; the card takes one or two`);
    if (v.length > MAX_SENTENCE_CHARS) err(path, `${v.length} characters; keep it under ${MAX_SENTENCE_CHARS}`);
  };

  const cause = section("cause", c.cause);
  if (cause) {
    str("cause.task", cause.task);
    if (typeof cause.task === "string" && cause.task && !/^ct-[a-z0-9]+$/i.test(cause.task)) err("cause.task", `expected a task short id (ct-N), got ${show(cause.task)}`);
    str("cause.title", cause.title);
    count("cause.signals", cause.signals);
    if (cause.first_seen !== null && (typeof cause.first_seen !== "number" || !Number.isFinite(cause.first_seen))) {
      err("cause.first_seen", `expected epoch milliseconds or null, got ${show(cause.first_seen)}`);
    }
    if (!Array.isArray(cause.sources) || cause.sources.some((s) => typeof s !== "string")) err("cause.sources", `expected an array of strings, got ${show(cause.sources)}`);
  }

  const goal = section("goal", c.goal);
  if (goal) {
    str("goal.ref", goal.ref);
    const named = typeof goal.ref === "string" && goal.ref.trim() !== "" && goal.ref !== "none";
    str("goal.name", goal.name, named);
    str("goal.why", goal.why, false);
  }

  if (c.ask !== undefined) {
    str("ask", c.ask, false);
    if (typeof c.ask === "string" && c.ask.length > MAX_SENTENCE_CHARS) err("ask", `${c.ask.length} characters; keep it under ${MAX_SENTENCE_CHARS}`);
  }
  if (c.headline !== undefined) {
    str("headline", c.headline);
    if (typeof c.headline === "string" && c.headline.length > MAX_HEADLINE_CHARS) err("headline", `${c.headline.length} characters; keep it under ${MAX_HEADLINE_CHARS}`);
  }
  if (c.context !== undefined) {
    sentences("context", c.context);
    if (typeof c.context === "string" && countSentences(c.context) > 1) err("context", "one sentence");
  }
  // The presenting session's words are its decision's, not the card's: a card
  // whose decision a session posted carries none of these, and one that does
  // carry them still keeps them short for the fixed card that shows them.
  for (const k of ["wrong", "change"] as const) {
    if (c[k] === undefined) continue;
    str(k, c[k], false);
    if (typeof c[k] === "string" && (c[k] as string).trim()) sentences(k, c[k]);
  }

  const proof = section("proof", c.proof);
  let parsedProof: ChangeCard["proof"] | null = null;
  if (proof) {
    const before = checks("proof.before", proof.before);
    const after = checks("proof.after", proof.after);
    parsedProof = { before, after };
    if (before.length && !before.some((x) => !x.ok)) err("proof.before", "no failing check; proof starts red (LE8)");
    if (before.length && !after.length) err("proof.after", "empty while proof.before has checks; show the same checks after the change");
    const afterNames = new Set(after.map((x) => x.name));
    for (const b of before) if (!b.ok && !afterNames.has(b.name)) err("proof.after", `no check named ${show(b.name)}; every red check needs its after`);
  }

  if (!Array.isArray(c.examples)) err("examples", `expected an array, got ${show(c.examples)}`);
  else {
    if (c.examples.length > MAX_EXAMPLES) err("examples", `${c.examples.length} examples; at most ${MAX_EXAMPLES}`);
    c.examples.forEach((ex, i) => {
      const p = `examples[${i}]`;
      if (!isObj(ex)) return err(p, `expected { input, before, after, note }, got ${show(ex)}`);
      str(`${p}.input`, ex.input);
      str(`${p}.before`, ex.before);
      str(`${p}.after`, ex.after);
      str(`${p}.note`, ex.note, false);
    });
  }

  if (c.seen !== undefined) {
    if (!Array.isArray(c.seen)) err("seen", `expected an array, got ${show(c.seen)}`);
    else {
      if (c.seen.length > MAX_SEEN) err("seen", `${c.seen.length} conversations; at most ${MAX_SEEN}`);
      c.seen.forEach((x, i) => {
        const p = `seen[${i}]`;
        if (!isObj(x)) return err(p, `expected { signal, asked, quote }, got ${show(x)}`);
        str(`${p}.signal`, x.signal);
        if (typeof x.signal === "string" && x.signal && !/^sg-\d+$/.test(x.signal)) err(`${p}.signal`, `expected a finding id (sg-N), got ${show(x.signal)}`);
        str(`${p}.asked`, x.asked);
        if (typeof x.asked === "string" && x.asked.length > MAX_ASKED_CHARS) err(`${p}.asked`, `${x.asked.length} characters; a few words, under ${MAX_ASKED_CHARS}`);
        str(`${p}.quote`, x.quote, false);
        if (x.missing !== undefined) str(`${p}.missing`, x.missing, false);
        if (typeof x.missing === "string" && x.missing.length > MAX_ASKED_CHARS) err(`${p}.missing`, `${x.missing.length} characters; a few words, under ${MAX_ASKED_CHARS}`);
      });
    }
  }

  if (c.reach !== undefined) {
    const r = section("reach", c.reach);
    if (r) {
      count("reach.conversations", r.conversations);
      count("reach.of", r.of);
      if (typeof r.conversations === "number" && typeof r.of === "number" && r.conversations > r.of) err("reach.conversations", `${r.conversations} is more than the ${r.of} conversations it is out of`);
      for (const k of ["covers", "read"] as const) {
        const ids = (r as Record<string, unknown>)[k];
        if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !/^sg-\d+$/.test(x)))) err(`reach.${k}`, `expected finding ids (sg-N), got ${show(ids)}`);
      }
      const read = (r as Record<string, unknown>).read;
      if (Array.isArray(read) && Array.isArray((r as Record<string, unknown>).covers)) {
        const stray = ((r as Record<string, unknown>).covers as string[]).filter((x) => !read.includes(x));
        if (stray.length) err("reach.covers", `${stray.join(", ")} ${stray.length === 1 ? "is not one" : "are not"} of this problem's findings (${read.join(", ")})`);
      }
    }
  }

  if (c.stops !== undefined) {
    const s = section("stops", c.stops);
    if (s) {
      count("stops.per_week", s.per_week);
      str("stops.what", s.what);
      if (typeof s.what === "string" && s.what.trim().split(/\s+/).length > 2) err("stops.what", `"${s.what}"; one or two words, the plural noun the card shows as "~N <what>/wk"`);
      str("stops.next", s.next);
      if (typeof s.next === "string" && s.next.length > MAX_NEXT_CHARS) err("stops.next", `${s.next.length} characters; one short clause, under ${MAX_NEXT_CHARS}`);
      if (s.basis !== undefined && (typeof s.basis !== "string" || s.basis.length > MAX_NEXT_CHARS)) err("stops.basis", `a few words on what the count was taken over, under ${MAX_NEXT_CHARS} characters`);
    }
  }

  if (c.overturns !== undefined) errors.push(...overturnsErrors(c.overturns));

  const cardChecks = checks("checks", c.checks);

  const diff = section("diff", c.diff);
  if (diff) {
    count("diff.files", diff.files);
    count("diff.added", diff.added);
    count("diff.removed", diff.removed);
    if (diff.pr !== undefined && (typeof diff.pr !== "string" || !/^https?:\/\//.test(diff.pr))) err("diff.pr", `expected a url, got ${show(diff.pr)}`);
  }

  const risk = section("risk", c.risk);
  if (risk) {
    oneOf("risk.class", risk.class, RISK_CLASSES);
    str("risk.reason", risk.reason);
    if (typeof risk.reason === "string" && risk.reason.length > MAX_RISK_CHARS) err("risk.reason", `${risk.reason.length} characters; a few words, under ${MAX_RISK_CHARS}`);
  }

  const rec = section("recommend", c.recommend);
  if (rec) {
    oneOf("recommend.verdict", rec.verdict, CHANGE_VERDICTS);
    str("recommend.why", rec.why);
    const conf: unknown = rec.confidence;
    if (conf !== undefined && !(typeof conf === "number" && Number.isInteger(conf) && conf >= 0 && conf <= 100)) {
      err("recommend.confidence", "a whole number from 0 to 100: the chance a person answers with this verdict");
    }
    const failing = cardChecks.filter((x) => !x.ok).map((x) => x.name);
    if (rec.verdict === "ship" && failing.length) {
      err("recommend.verdict", failing.includes(BASE_CHECK)
        ? `ship over failing checks (${failing.join(", ")}); the branch is stale against main, so recommend revise with the ask "${REBUILD_ON_MAIN}"`
        : `ship over failing checks (${failing.join(", ")}); recommend revise or drop`);
    }
    // A red proof check still red, or a check the change broke, is a failing
    // check too: Ship needs the proof green (LE8).
    // A count the reason gives for the proof ("all three proven misses") must
    // be the proof's own count, or the card says two numbers for one thing.
    // A proof with nothing red is refused under proof already.
    const proofRed = parsedProof ? parsedProof.before.filter((x) => !x.ok).length : 0;
    if (proofRed && typeof rec.why === "string") {
      const red = proofRed;
      for (const n of proofCountsIn(rec.why)) {
        if (n !== red) err("recommend.why", `says ${n} proven ${n === 1 ? "miss" : "misses"}, but the proof shows ${red}`);
      }
    }
    // A count of conversations in the why is the card's own reach, the pair its Conversations tile shows (and re-reads live).
    const reachPair = isObj(c.reach) ? c.reach : null;
    if (typeof rec.why === "string" && reachPair) {
      for (const m of rec.why.matchAll(REACH_IN_WHY)) {
        if (Number(m[1]) !== reachPair.conversations || Number(m[2]) !== reachPair.of) err("recommend.why", `says ${m[1]} of ${m[2]} conversations, but reach is ${reachPair.conversations} of ${reachPair.of}; one count feeds the tile and the why`);
      }
    }
    if (rec.verdict === "ship" && parsedProof) {
      const p = proofSummary(parsedProof);
      // A red check with no after at all is already named under proof.after.
      const shownAfter = new Set(parsedProof.after.map((x) => x.name));
      const red = [...p.stillRed.filter((n) => shownAfter.has(n)).map((n) => `${n} still red`), ...p.broke.map((n) => `${n} broke`)];
      if (red.length) err("recommend.verdict", `ship over a red proof (${red.join(", ")}); recommend revise or drop`);
    }
  }

  const cost = section("cost", c.cost);
  if (cost) {
    count("cost.tokens", cost.tokens);
    count("cost.usd", cost.usd);
    count("cost.minutes", cost.minutes);
    if (cost.list_usd !== undefined) count("cost.list_usd", cost.list_usd);
  }

  if (c.earlier !== undefined) {
    if (!Array.isArray(c.earlier)) err("earlier", `expected an array, got ${show(c.earlier)}`);
    else c.earlier.forEach((f, i) => {
      const p = `earlier[${i}]`;
      if (!isObj(f)) return err(p, `expected { attempt, change, live, held, back }, got ${show(f)}`);
      count(`${p}.attempt`, f.attempt);
      str(`${p}.change`, f.change);
      str(`${p}.live`, f.live);
      for (const k of ["ref", "held", "back"] as const) if (f[k] !== null && typeof f[k] !== "string") err(`${p}.${k}`, `expected a string or null, got ${show(f[k])}`);
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, card: input as unknown as ChangeCard };
}

// ── helpers the renderers share ──────────────────────────────────────────────

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, both: 2 };

/**
 * The counts a sentence gives for the proof: "all three proven misses", "2 red
 * checks", "both misses". Only words that name the proof count: "failing
 * checks" and bare "checks" are left alone, because the card's own checks
 * (verify, eval, review) fail too and a reason may count those.
 */
export function proofCountsIn(text: string): number[] {
  const out: number[] = [];
  const re = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|both)\s+(?:proven\s+)?(?:miss(?:es)?|red checks?|proof checks?)\b/gi;
  for (const m of text.matchAll(re)) {
    const w = m[1]!.toLowerCase();
    out.push(/^\d+$/.test(w) ? Number(w) : COUNT_WORDS[w]!);
  }
  return out;
}

export interface ProofSummary {
  /** Checks red before the change. */
  red: number;
  /** Of those, how many are green after. */
  fixed: number;
  /** Red before and still red after. */
  stillRed: string[];
  /** Green before (or new) and red after: what the change broke. */
  broke: string[];
  /** The proof in one sentence, the one every surface says: "4 of 4 cases fixed", "2 of 3 cases fixed, 1 new failure", "No proof recorded". */
  evidence: string;
}

export function proofSummary(proof: ChangeCard["proof"]): ProofSummary {
  const after = new Map(proof.after.map((x) => [x.name, x.ok]));
  const redBefore = proof.before.filter((x) => !x.ok).map((x) => x.name);
  const fixed = redBefore.filter((n) => after.get(n) === true).length;
  const stillRed = redBefore.filter((n) => after.get(n) !== true);
  const broke = proof.after.filter((x) => !x.ok && !redBefore.includes(x.name)).map((x) => x.name);
  // Cases, never "checks": the card's own checks (Verify, Eval, Review) are
  // a separate count, and one word for two things reads as a contradiction.
  // Short, so a narrow row wraps it whole; the bad news comes last but never
  // runs long enough to be the part a row clips.
  const evidence = !redBefore.length
    ? proof.after.length ? `${proof.after.length} ${proof.after.length === 1 ? "check" : "checks"}, none shown failing first` : "No proof recorded"
    : `${fixed} of ${redBefore.length} ${redBefore.length === 1 ? "case" : "cases"} fixed${broke.length ? `, ${broke.length} new ${broke.length === 1 ? "failure" : "failures"}` : ""}`;
  return { red: redBefore.length, fixed, stillRed, broke, evidence };
}

/**
 * Whether a check's own words report a failure ("11 pass, 1 fail", "2
 * errors"), whatever its flag says. A check that says it failed is never
 * drawn green and never counted as passing.
 */
export function reportsFailure(detail: string): boolean {
  return /\b[1-9]\d*\s+(?:fail(?:s|ed|ing|ures?)?|errors?|regress(?:ed|ions?)?)\b/i.test(detail);
}

/** The check the proof stands for in the card's check list. */
export const PROOF_CHECK = "Proof";

/**
 * The one list every surface counts failures from: the proof as a check
 * (red while a proven miss still fails or the change broke a case), then the
 * card's own checks with any whose detail reports a failure marked failing.
 * The Checks cell, the queue row and the badge on Ship all read this, so a
 * card says one number for what is wrong.
 */
export function cardChecks(card: Pick<ChangeCard, "proof" | "checks">): CardCheck[] {
  const p = proofSummary(card.proof);
  const proof: CardCheck[] = p.red || p.broke.length ? [{ name: PROOF_CHECK, ok: !p.stillRed.length && !p.broke.length, detail: p.evidence }] : [];
  return [...proof, ...honestChecks(card.checks)];
}

/** The card's own checks, each whose detail reports a failure (reportsFailure) marked failing. */
export function honestChecks(checks: readonly CardCheck[]): CardCheck[] {
  return checks.map((c) => (c.ok && reportsFailure(c.detail) ? { ...c, ok: false } : c));
}

/** How many of a card's checks fail (cardChecks): the number on Ship's badge. */
export function cardFailing(card: Pick<ChangeCard, "proof" | "checks">): number {
  return cardChecks(card).filter((c) => !c.ok).length;
}

/** The checks in words, one count: "3 checks pass", "2 of 5 checks fail". `bare` drops "checks" where a label already names them. */
export function checksLabel(checks: ReadonlyArray<{ ok: boolean }>, bare = false): string {
  const failing = checks.filter((c) => !c.ok).length;
  const noun = bare ? "" : ` ${checks.length === 1 ? "check" : "checks"}`;
  if (!failing) return bare ? `${checks.length} of ${checks.length} pass` : `${checks.length}${noun} ${checks.length === 1 ? "passes" : "pass"}`;
  return `${failing} of ${checks.length}${noun} fail`;
}

/**
 * The risk in plain words: "Low risk", "Medium risk", "High risk: needs its
 * own plan". `short` drops the clause after the level, for a dense row.
 */
export function riskLabel(risk: Pick<ChangeCard["risk"], "class">, short = false): string {
  if (risk.class === "low") return "Low risk";
  if (risk.class === "review") return "Medium risk";
  return short ? "High risk" : "High risk: needs its own plan";
}

/** The recommendation's confidence as a card says it ("80% sure"), or null on a card without one. */
export function confidenceLabel(rec: { confidence?: number } | null | undefined): string | null {
  return typeof rec?.confidence === "number" ? `${rec.confidence}% sure` : null;
}

/** The answer's word, or a neutral one while the card has no recommendation yet. */
export function verdictLabel(verdict: ChangeVerdict | "" | undefined): string {
  return verdict === "ship" ? "Ship" : verdict === "revise" ? "Revise" : verdict === "drop" ? "Drop" : "No recommendation";
}

export { CARD_GATE_NODE_ID, LINE_END_NODES, cardAnswered, endedFailing, endedUnmerged, isLineRun, lineRunOutcome, mergeLeft, passedUnansweredCard, runEnd, type AnsweredGate, type LineRunEnd, type LineRunStations } from "./lineRunEnd";

/** The verdict a gate option names ("Revise", "[R] Revise", "Drop the change"), or null. */
export function verdictOfOption(label: string | undefined): ChangeVerdict | null {
  const word = (label ?? "").replace(/^\[[^\]]*\]\s*/, "").trim().toLowerCase();
  return CHANGE_VERDICTS.find((v) => word === v || word.startsWith(`${v} `) || word.startsWith(`${v}:`)) ?? null;
}

// ── the decision a card asks (LE11) ─────────────────────────────────────────

/** The three answers a card's decision offers, in this order, so 1 2 3 read Ship Revise Drop everywhere. */
export const CARD_DECISION_OPTIONS: ReadonlyArray<{ label: string; description: string }> = [
  { label: "Ship", description: "Merge the change and watch for the problem." },
  { label: "Revise", description: "Send it back to build with a note." },
  { label: "Drop", description: "Close it without merging." },
];

/** Which option index answers each verdict, read from the labels; null when the options are not Ship, Revise and Drop. */
export function cardVerdictIndexes(options: ReadonlyArray<{ label: string }>): Record<ChangeVerdict, number> | null {
  const at = (v: ChangeVerdict) => options.findIndex((o) => o.label.replace(/^\[\w\]\s*/, "").trim().toLowerCase().startsWith(v));
  const out = { ship: at("ship"), revise: at("revise"), drop: at("drop") };
  return out.ship < 0 || out.revise < 0 || out.drop < 0 ? null : out;
}

// ── assembly ─────────────────────────────────────────────────────────────────

/** The task row fields the card reads: the cause (LE4) and ground (LE5) fields, read loosely because older tasks lack them. */
export interface CardTaskInput {
  short_id: string;
  title: string;
  source?: string | null;
  cause?: { signal_count?: number; first_seen?: number; sources?: string[] } | null;
  goal_ref?: string | null;
  goal_name?: string | null;
  goal_why?: string | null;
  risk?: string | null;
  risk_reason?: string | null;
  /** What kind of change it is (the ground field): a prompt or line change with no eval result says it is unscored. */
  category?: string | null;
}

/** The slice of the task's evidence (taskEvidence.ts) the card reads. */
export interface CardEvidenceInput {
  files_changed: string[];
  verification_evidence: string | null;
  execution_status: string | null;
  pr_url: string | null;
  review_verdict: { verdict: string; note?: string } | null;
}

/**
 * A card's cost as two kinds that never add: money billed, and the API list
 * price of its subscription sessions, an equivalent only. A card built before
 * the two were told apart has no `list_usd`; its `usd` was its sessions at
 * list price (those cards carried no eval cost), so it reads as that.
 */
export function costParts(cost: { usd: number; list_usd?: number }): { billed_usd: number; list_usd: number } {
  return cost.list_usd === undefined ? { billed_usd: 0, list_usd: cost.usd } : { billed_usd: cost.usd, list_usd: cost.list_usd };
}

/** Dollars as cost surfaces print them. */
export const costUsd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

export interface CardAssemblyInput {
  task: CardTaskInput;
  evidence?: CardEvidenceInput | null;
  /** The current run's own Verify step (runVerify), which outranks a handoff an earlier run left. */
  verify?: CardCheck | null;
  evalResult?: EvalResult | null;
  /** A proof recorded outside evals (a failing test's red and green run). Merged ahead of the eval proof. */
  proof?: ChangeCard["proof"] | null;
  diff?: { files: number; added: number; removed: number } | null;
  /** The branch against main (BranchBase); null when git could not say. */
  base?: BranchBase | null;
  cost?: { tokens?: number; minutes?: number; usd?: number; list_usd?: number } | null;
  headline?: string;
  context?: string;
  ask?: string;
  wrong?: string;
  change?: string;
  recommend?: { verdict: ChangeVerdict; why: string; confidence?: number } | null;
  /** The cause's earlier shipped fixes (causeHistory earlierFixes). */
  earlier?: EarlierFix[] | null;
  /** The author's reading of the risk: what the change touches and how much traffic reaches it. Outranks the task's ground rating. */
  risk?: { class: RiskClass; reason: string } | null;
  /** The author's picks of the conversations behind the cause (CardSeen). */
  seen?: CardSeen[] | null;
  /** How many of the problem's conversations the change reaches (CardReach). */
  reach?: CardReach | null;
  /** What a change that sends less stops per week, and what the contact hears next (CardStops). */
  stops?: CardStops | null;
  /** The earlier call the change reverses (CardOverturns). */
  overturns?: CardOverturns | null;
  /** Real cases before and after, written by the card's author from the run's record, for a change no eval replayed. Eval flips win when there are any. */
  examples?: CardExample[] | null;
}

/** The judge's first sentence: the verdict a reader needs, before the reasoning. */
const firstSentence = (s: string) => (s.trim().match(/^[\s\S]*?[.!?](?=\s+[A-Z"'(]|\s*$)/)?.[0] ?? s.trim());
const firstLine = (s: string | null | undefined) => (s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** One surface's eval result in words a cold reader follows; the statistics stay in the eval record. */
function surfaceLine(s: EvalSurfaceResult): string {
  if (s.skipped) return `${s.title || s.surface}: not tested, ${s.skipped}`;
  const verdict = s.separation === "better" ? "clearly better than before"
    : s.separation === "worse" ? "clearly worse than before"
    : s.separation === "too-few" ? "too few runs to tell"
    : "no clear difference from before";
  const gates = s.gatesFailed.length ? `; ${s.gatesFailed.length} required ${s.gatesFailed.length === 1 ? "test" : "tests"} failed` : "";
  return `${s.title || s.surface}: ${verdict}${gates}`;
}

/** The check a card carries when the project's suite gates failed (reps.json gates_failed): red, naming each failing scenario, so Ship is refused like any failing check. */
export const SUITE_GATE_CHECK = "Suite gates";
export function suiteGateCheck(failed: readonly string[]): CardCheck {
  return { name: SUITE_GATE_CHECK, ok: false, detail: `${failed.length} ${failed.length === 1 ? "scenario" : "scenarios"} failed: ${failed.join(", ")}` };
}

/** Where the change's branch stands against main, read from git when the card is built. */
export interface BranchBase {
  /** Commits on main the branch does not have. */
  behind: number;
  /** Files the change touches that main has changed since the branch was cut. */
  changedOnMain: string[];
  /** Files that conflict when the branch merges into main today. */
  conflicts: string[];
}

/**
 * The card's "Up to date" check: whether what was built and proven is what
 * would merge. A branch that conflicts with main, or whose touched files main
 * has changed since, was proven on code that no longer exists, so the check
 * fails and Ship is refused like any failing check; its detail opens with the
 * action. A branch merely behind main on files it does not touch passes.
 */
export const BASE_CHECK = "Up to date";
export const REBUILD_ON_MAIN = "Rebuild on main";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function baseCheck(b: BranchBase): CardCheck {
  const behind = `${plural(b.behind, "commit")} behind`;
  const files = (list: string[]) => list.slice(0, 3).map((f) => f.split("/").pop()).join(", ") + (list.length > 3 ? ` and ${list.length - 3} more` : "");
  // The part before ";" is what a card's chip shows (checkShort, 60 characters); the files follow it.
  if (b.conflicts.length) return { name: BASE_CHECK, ok: false, detail: `${REBUILD_ON_MAIN}: ${behind}, ${plural(b.conflicts.length, "file")} ${b.conflicts.length === 1 ? "conflicts" : "conflict"}; ${files(b.conflicts)}` };
  if (b.changedOnMain.length) return { name: BASE_CHECK, ok: false, detail: `${REBUILD_ON_MAIN}: ${behind}, ${plural(b.changedOnMain.length, "file")} changed there; the proof ran on old ${files(b.changedOnMain)}` };
  return { name: BASE_CHECK, ok: true, detail: b.behind ? `${behind} main, none of its files changed there` : "Built on current main" };
}

/** The eval station's proof: each proven freeze was red before the change (on the base), and is green after it when it passes. The details say before and after, never a ref, because the founder reads them. */
export function evalProof(result: EvalResult): ChangeCard["proof"] {
  const before: CardCheck[] = [];
  const after: CardCheck[] = [];
  let n = 0;
  for (const s of result.surfaces) {
    for (const p of s.proven) {
      // A reader knows a case by its place on the card, not by its freeze ref.
      const name = `Real case ${++n}`;
      // Read loosely: a result written before base verdicts were recorded has none, and its proven freezes were shown red.
      const basePasses = (p as { basePasses?: boolean | null }).basePasses;
      before.push({ name, ok: basePasses === true, detail: basePasses === true ? "already passes before the change" : basePasses === null ? "no verdict before the change" : "fails before the change" });
      after.push({ name, ok: p.passes, detail: p.passes ? "passes after the change" : "still fails after the change" });
    }
  }
  return { before, after };
}

/** Flipped freezes as examples: what the change fixed first, then anything it broke, at most three. */
export function evalExamples(result: EvalResult): CardExample[] {
  const flips = result.surfaces.flatMap((s) => s.flips);
  const ordered = [...flips.filter((f) => f.direction === "fixed"), ...flips.filter((f) => f.direction === "broke")];
  return ordered.slice(0, MAX_EXAMPLES).map((f) => {
    // The input arrives labelled with the freeze's ref; the reader needs only what was said.
    const input = f.name && f.input.startsWith(`${f.name}: `) ? f.input.slice(f.name.length + 2) : f.input;
    const note = firstSentence(f.note);
    return { input, before: f.before, after: f.after, note: f.direction === "broke" ? `Regressed. ${note}` : note };
  });
}

/**
 * The card from what the nodes recorded. Pure, so the CLI, a workflow node and
 * a test build it the same way. Fields the model writes come in as given and
 * stay empty when absent, so validateChangeCard names them.
 */
/** The Verify check from a run's own verify step, once it finished: what this run's checks said, not what an earlier
 *  run's handoff left on the task. Null while the step has not run. */
export function runVerify(nodes: ReadonlyArray<{ node_id: string; status?: string; outcome?: string; result_preview?: string; error?: string }> | null | undefined): CardCheck | null {
  const v = nodes?.find((n) => n.node_id === "verify");
  if (!v || (v.status !== "completed" && v.status !== "failed")) return null;
  const ok = v.status === "completed" && v.outcome !== "failure";
  // The checks the step printed, counted the way the run's own Verify row counts them: one figure on both.
  const steps = reportSteps(v.result_preview);
  if (steps) {
    const red = steps.filter((c) => !c.ok).map((c) => c.name);
    return { name: "Verify", ok: ok && red.length === 0, detail: red.length ? `${checksPassWords(steps).text}: ${red.join(", ")}` : checksPassWords(steps).text };
  }
  return { name: "Verify", ok, detail: ok ? "Typecheck and tests passed on this run" : firstSentence(firstLine(v.error || v.result_preview)) || "Typecheck or tests failed on this run" };
}

/** The checks a check runner reported on the first line of what it printed (`{ok, steps: [{name, ok}]}`), each
 *  named without its parenthesised scope; null when it printed no such report. */
export function reportSteps(printed: string | null | undefined): Array<{ name: string; ok: boolean }> | null {
  let report: unknown;
  try { report = JSON.parse(firstLine(printed ?? "")); } catch { return null; }
  const steps = (report as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return null;
  const rows = steps.filter((x): x is { name: string; ok?: unknown } => !!x && typeof x.name === "string").map((x) => ({ name: x.name.replace(/\s*\(.*$/, "").trim() || x.name, ok: x.ok !== false }));
  return rows.length ? rows : null;
}

/** Checks in one glance: "4/4 pass", "3/4 pass, 1 red"; `bad` when any failed. The run's Verify row and a card's
 *  Verify check both say it, so the two never disagree. */
export function checksPassWords(rows: ReadonlyArray<{ ok: boolean }>): { text: string; bad: boolean } {
  const red = rows.filter((r) => !r.ok).length;
  const n = rows.length;
  return { text: red ? `${n - red}/${n} pass, ${red} red` : `${n}/${n} pass`, bad: red > 0 };
}

/** The word that opens the Eval check of a change no eval judged. */
const UNSCORED = "Unscored:";
/** The Eval check of a prompt or line change no eval judged. */
export const UNSCORED_DETAIL = `${UNSCORED} this project's flow has no eval command, so no eval replayed the changed prompt`;
/** A check that never ran (the unscored Eval): it fails nothing, and it passed nothing either, so a card draws it neither green nor red.
 *  Read by its opening word: a card keeps the detail its run wrote, and cards written before 2026-10-25 say "line" where this says "flow". */
export const checkNotRun = (c: CardCheck): boolean => !!c.detail?.startsWith(UNSCORED);
/** Whether the card owes an eval nobody scored: a Ship it recommends then reads "Ship after evals". */
export const evalsOwed = (card: Pick<ChangeCard, "checks">): boolean => card.checks.some(checkNotRun);

export function assembleChangeCard(input: CardAssemblyInput): ChangeCard {
  const { task, evidence, evalResult } = input;
  const cause = task.cause ?? null;
  const goalRef = task.goal_ref?.trim() || "none";

  const evalP = evalResult ? evalProof(evalResult) : { before: [], after: [] };
  const proof = {
    before: [...(input.proof?.before ?? []), ...evalP.before],
    after: [...(input.proof?.after ?? []), ...evalP.after],
  };

  const checks: CardCheck[] = [];
  if (input.verify) checks.push(input.verify);
  else if (evidence?.execution_status || evidence?.verification_evidence) {
    const ok = evidence.execution_status === "done" && !reportsFailure(firstLine(evidence.verification_evidence));
    // A pass says what passed; a failure quotes the builder's own first sentence, the reason a reader needs.
    checks.push({
      name: "Verify",
      ok,
      detail: ok ? "The builder handed it over as done" : firstSentence(firstLine(evidence.verification_evidence)) || `the builder marked its handoff ${evidence.execution_status}`,
    });
  }
  if (evalResult) {
    // A failed suite gate is its own check, so the Eval check answers for the
    // replays alone and one red is never counted twice.
    const gates = evalResult.gatesFailed ?? [];
    checks.push({
      name: "Eval",
      ok: gates.length ? evalResult.surfaces.every((s) => s.ok) : evalResult.ok,
      detail: evalResult.surfaces.length ? evalResult.surfaces.map(surfaceLine).join("; ") : "no surface touched",
    });
    if (gates.length) checks.push(suiteGateCheck(gates));
  } else if (task.category === "prompt" || task.category === "line") {
    // A prompt change is proven by evals (prompting.md P9). Without them the
    // card says so in place of the verdict it lacks (line-map.md LX6).
    checks.push({ name: "Eval", ok: true, detail: UNSCORED_DETAIL });
  }
  if (evidence?.review_verdict) {
    checks.push({
      name: "Review",
      ok: evidence.review_verdict.verdict === "approve",
      detail: evidence.review_verdict.verdict === "approve" ? "An independent reviewer approved it" : firstSentence(evidence.review_verdict.note?.trim() || evidence.review_verdict.verdict),
    });
  }
  if (input.base) checks.push(baseCheck(input.base));

  const risk = (RISK_CLASSES as readonly string[]).includes(task.risk ?? "") ? (task.risk as RiskClass) : "review";
  const pr = evidence?.pr_url ?? undefined;

  return {
    cause: {
      task: task.short_id,
      title: task.title,
      signals: cause?.signal_count ?? 0,
      first_seen: cause?.first_seen ?? null,
      sources: cause?.sources?.length ? cause.sources : task.source ? [task.source] : [],
    },
    goal: {
      ref: goalRef,
      name: task.goal_name?.trim() || (goalRef === "none" ? "" : goalRef),
      why: task.goal_why?.trim() ?? "",
    },
    ...(input.headline?.trim() ? { headline: input.headline.trim() } : {}),
    ...(input.ask?.trim() && input.recommend?.verdict === "revise" ? { ask: input.ask.trim() } : {}),
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    wrong: input.wrong?.trim() ?? "",
    change: input.change?.trim() ?? "",
    proof,
    examples: evalResult && evalExamples(evalResult).length ? evalExamples(evalResult) : (input.examples ?? []).slice(0, MAX_EXAMPLES),
    ...(input.seen?.length ? { seen: input.seen.slice(0, MAX_SEEN) } : {}),
    ...(input.reach ? { reach: input.reach } : {}),
    ...(input.stops ? { stops: input.stops } : {}),
    ...(input.overturns ? { overturns: input.overturns } : {}),
    checks,
    diff: {
      files: input.diff?.files ?? evidence?.files_changed.length ?? 0,
      added: input.diff?.added ?? 0,
      removed: input.diff?.removed ?? 0,
      ...(pr ? { pr } : {}),
    },
    risk: input.risk && (RISK_CLASSES as readonly string[]).includes(input.risk.class) && input.risk.reason.trim()
      ? { class: input.risk.class, reason: input.risk.reason.trim() }
      : {
          class: risk,
          reason: task.risk_reason?.trim() || (task.risk ? `An agent rated it ${risk === "review" ? "worth a human review" : `${risk} risk`}.` : "Not grounded yet, so it gets a careful look."),
        },
    recommend: input.recommend ?? ({ verdict: "", why: "" } as unknown as ChangeCard["recommend"]),
    cost: {
      tokens: Math.round(input.cost?.tokens ?? 0),
      usd: Math.round(((input.cost?.usd ?? 0) + (evalResult?.costUsd ?? 0)) * 100) / 100,
      minutes: Math.round(input.cost?.minutes ?? 0),
      list_usd: Math.round((input.cost?.list_usd ?? 0) * 100) / 100,
    },
    ...(input.earlier?.length ? { earlier: input.earlier } : {}),
  };
}

/** A gate's doc as a person reads it: without the runner's own `work_state:` line (bookkeeping, never the plan's words).
 *  The runner writes docs through it, and a page reads older docs through it. */
export const gateDoc = (doc: string): string => doc.replace(/(^|\n)work_state:[^\n]*(?:\n|$)/g, "$1").trim();
