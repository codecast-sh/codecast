// The change card (docs/architecture/the-line-end-to-end.md LE10): the one
// fixed shape every run on the line ends in, whatever it changed. Code fixes,
// prompt changes, UX changes and escalations all render the same card, and the
// person answers it Ship, Revise or Drop (LE11).
//
// Only `wrong`, `change` and `recommend` are written by a model. Everything
// else is assembled from what the nodes recorded: the cause and ground fields
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

export interface ChangeCard {
  cause: { task: string; title: string; signals: number; first_seen: number | null; sources: string[] };
  goal: { ref: string; name: string; why: string };
  /** The card's title in plain words, for a reader who did not follow the work. */
  headline?: string;
  /** One sentence on what the affected part of the product is and who sees it. */
  context?: string;
  wrong: string;
  change: string;
  proof: { before: CardCheck[]; after: CardCheck[] };
  examples: CardExample[];
  checks: CardCheck[];
  diff: { files: number; added: number; removed: number; pr?: string };
  risk: { class: RiskClass; reason: string };
  recommend: { verdict: ChangeVerdict; why: string };
  cost: { tokens: number; usd: number; minutes: number };
  /** The cause's earlier shipped fixes, oldest first, so a person sees what was tried beside what is proposed now, and whether it held (line-workspace.md LW5). Absent when nothing shipped before. */
  earlier?: EarlierFix[];
}

// ── validation ───────────────────────────────────────────────────────────────

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

  if (c.headline !== undefined) {
    str("headline", c.headline);
    if (typeof c.headline === "string" && c.headline.length > MAX_HEADLINE_CHARS) err("headline", `${c.headline.length} characters; keep it under ${MAX_HEADLINE_CHARS}`);
  }
  if (c.context !== undefined) {
    sentences("context", c.context);
    if (typeof c.context === "string" && countSentences(c.context) > 1) err("context", "one sentence");
  }
  sentences("wrong", c.wrong);
  sentences("change", c.change);

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
  }

  const rec = section("recommend", c.recommend);
  if (rec) {
    oneOf("recommend.verdict", rec.verdict, CHANGE_VERDICTS);
    sentences("recommend.why", rec.why);
    const failing = cardChecks.filter((x) => !x.ok).map((x) => x.name);
    if (rec.verdict === "ship" && failing.length) err("recommend.verdict", `ship over failing checks (${failing.join(", ")}); recommend revise or drop`);
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

/** The answer's word, or a neutral one while the card has no recommendation yet. */
export function verdictLabel(verdict: ChangeVerdict | "" | undefined): string {
  return verdict === "ship" ? "Ship" : verdict === "revise" ? "Revise" : verdict === "drop" ? "Drop" : "No recommendation";
}

/** The line template's decide gate (LE11): the node whose decision is the card. */
export const CARD_GATE_NODE_ID = "decide";

/** What a line run did to its cause (LE12, LE16), read from its stations:
 *  the watch station runs only after the change landed (ship, or merge), so a
 *  completed watch is the ship record; drop, dissolve and park each end the
 *  run at their own station. Every line run starts at ground, which is how a
 *  run of another workflow with a station of the same name is told apart. */
export type LineRunEnd = "shipped" | "dropped" | "dissolved" | "parked";
const LINE_FIRST_NODE_ID = "ground";
/** The stations that end a line run, and the end each means. */
export const LINE_END_NODES: Readonly<Record<string, LineRunEnd>> = { watch: "shipped", drop: "dropped", dissolve: "dissolved", park: "parked" };

/** Whether a run's stations are the line's (it started at ground). */
export function isLineRun(nodes: ReadonlyArray<{ node_id: string }> | undefined): boolean {
  return !!nodes?.some((n) => n.node_id === LINE_FIRST_NODE_ID);
}

/** The latest end station a line run completed and when, or null when it reached none. */
/** A run that went on past a card nobody answered (its decide gate failed)
 *  and still reached ship. Nothing approved it, so nothing after the card is
 *  a ship, on any graph. */
export function passedUnansweredCard(nodes: ReadonlyArray<{ node_id: string; status: string; outcome?: string | null }> | undefined): boolean {
  // An answered gate records the chosen key as its outcome ("s"); only a gate
  // that came back with no answer records "failure".
  const decide = nodes?.find((n) => n.node_id === CARD_GATE_NODE_ID);
  const ship = nodes?.find((n) => n.node_id === "ship");
  return decide?.outcome === "failure" && ship?.status === "completed";
}

export function lineRunOutcome(
  nodes: ReadonlyArray<{ node_id: string; status: string; started_at?: number; completed_at?: number }> | undefined,
): { kind: LineRunEnd; at: number } | null {
  if (!nodes || !isLineRun(nodes) || passedUnansweredCard(nodes)) return null;
  let best: { kind: LineRunEnd; at: number } | null = null;
  for (const n of nodes) {
    const kind = LINE_END_NODES[n.node_id];
    if (!kind || n.status !== "completed") continue;
    const at = n.completed_at ?? n.started_at ?? 0;
    if (!best || at >= best.at) best = { kind, at };
  }
  return best;
}

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

export interface CardAssemblyInput {
  task: CardTaskInput;
  evidence?: CardEvidenceInput | null;
  evalResult?: EvalResult | null;
  /** A proof recorded outside evals (a failing test's red and green run). Merged ahead of the eval proof. */
  proof?: ChangeCard["proof"] | null;
  diff?: { files: number; added: number; removed: number } | null;
  cost?: { tokens?: number; minutes?: number; usd?: number } | null;
  headline?: string;
  context?: string;
  wrong?: string;
  change?: string;
  recommend?: { verdict: ChangeVerdict; why: string } | null;
  /** The cause's earlier shipped fixes (causeHistory earlierFixes). */
  earlier?: EarlierFix[] | null;
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
/** The Eval check of a prompt or line change no eval judged. */
export const UNSCORED_DETAIL = "Unscored: this project's line has no eval command, so no eval replayed the changed prompt";

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
  if (evidence?.execution_status || evidence?.verification_evidence) {
    const ok = evidence.execution_status === "done" && !reportsFailure(firstLine(evidence.verification_evidence));
    // A pass says what passed; a failure quotes the builder's own first sentence, the reason a reader needs.
    checks.push({
      name: "Verify",
      ok,
      detail: ok ? "The builder handed it over as done" : firstSentence(firstLine(evidence.verification_evidence)) || `handoff status ${evidence.execution_status}`,
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
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    wrong: input.wrong?.trim() ?? "",
    change: input.change?.trim() ?? "",
    proof,
    examples: evalResult ? evalExamples(evalResult) : [],
    checks,
    diff: {
      files: input.diff?.files ?? evidence?.files_changed.length ?? 0,
      added: input.diff?.added ?? 0,
      removed: input.diff?.removed ?? 0,
      ...(pr ? { pr } : {}),
    },
    risk: {
      class: risk,
      reason: task.risk_reason?.trim() || (task.risk ? `An agent rated it ${risk === "review" ? "worth a human review" : `${risk} risk`}.` : "Not grounded yet, so it gets a careful look."),
    },
    recommend: input.recommend ?? ({ verdict: "", why: "" } as unknown as ChangeCard["recommend"]),
    cost: {
      tokens: Math.round(input.cost?.tokens ?? 0),
      usd: Math.round(((input.cost?.usd ?? 0) + (evalResult?.costUsd ?? 0)) * 100) / 100,
      minutes: Math.round(input.cost?.minutes ?? 0),
    },
    ...(input.earlier?.length ? { earlier: input.earlier } : {}),
  };
}
