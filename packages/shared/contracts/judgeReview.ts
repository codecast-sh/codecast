// Improving a judge (docs/architecture/learning-loop.md LL4, LL11): where a
// wrong finding's case goes once its diagnosis answers the one question.
// Pure, so the server that files the case, the CLI that prints it and the
// web model that shows it name each part of a judge the same way.

/** The source of a case against a judge; a case opens its problem by itself (LE4). */
export const JUDGE_CASE_SOURCE = "judge-review";

/** The shipped graph that diagnoses one wrong finding (templates/judge-review.cast). */
export const JUDGE_REVIEW_GRAPH = "judge-review";

/** How many diagnosis runs one wrong finding gets before it waits for a person. */
export const JUDGE_REVIEW_ATTEMPTS = 3;

/**
 * missing: the fact the judge needed to judge correctly was not in what it
 * saw. misread: it was there and the judge got it wrong. upheld: the
 * product's records show the finding was right after all, so there is no
 * case against the judge.
 */
export const DIAGNOSIS_ANSWERS = ["missing", "misread", "upheld"] as const;
export type DiagnosisAnswer = (typeof DIAGNOSIS_ANSWERS)[number];
/** The answers that make a case against a part of the judge. */
export type CaseAnswer = Exclude<DiagnosisAnswer, "upheld">;

/** What a case is filed against: the judge's prompt, the input a product's judge is given, or the extractor that froze the moment. */
export type CaseTarget = "judge" | "input" | "extractor";

export type WrongFinding = {
  /** The judge that made the finding. */
  judge: string;
  /** The finding's source: the product's finder, or `judge:<name>` for a codecast judge. */
  source: string;
  /** The moment a codecast judge read (bring moments); absent for a product's own judge. */
  moment?: string;
  /** That moment's kind and the event source it came from, when it has one. */
  moment_kind?: string;
  moment_source?: string;
  /** The expectation the finding said was broken (its subject, ex-N), and that line's words. */
  expectation?: string;
  expectation_text?: string;
  /** The wrong finding's short id: each case keys by its own finding until grouping joins it to a sibling. */
  finding?: string;
};

export type CaseRoute = {
  against: CaseTarget;
  /** The issue key every case on this judge line gathers under: one problem per line. */
  key: string;
  /** misread is a prompt to rewrite; a missing fact is code that builds what the judge sees. */
  kind: "prompt_miss" | "bug";
  /** The problem's title, in the words a person reads (LL6). */
  title: string;
  /** The part at fault, in plain words: what the case is about (LL6), never the key. */
  part: string;
};

const keyPart = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * Where the product's judge lives: a codecast judge (bring moments) is
 * codecast's, a product's judge is its finder's.
 */
function judgeHome(f: WrongFinding): string {
  return f.moment ? "codecast" : keyPart(f.source);
}

/** An expectation's first clause, for a title a person reads at a glance. */
function lineWords(text: string): string {
  const first = text.split(/[;:]/)[0].trim().replace(/[.]$/, "");
  return first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
}

/**
 * misread files against the judge. missing files against what fed it: the
 * extractor that froze the moment (bring moments), else the product's builder
 * of the judge's input (bring findings).
 *
 * Each case opens under a key of its own (the part at fault and the wrong
 * finding), and grouping (judgeReview.groupCase) then folds it into the open
 * case problem whose cases name the same diagnosed fact against the same kind
 * of part. Neither the part nor the judge line is the fix: keyed by part, one
 * problem held a truncated email, a timing gap and an apology ruling; keyed by
 * judge line, one problem held a prompt rule, two extractor folds and a
 * missing operator note, while one email's misread fee lane opened a problem
 * per line it was judged on (pl-882, 2026-10-12). The title names the part and
 * the line the judge got wrong.
 */
export function caseRoute(f: WrongFinding, answer: CaseAnswer): CaseRoute {
  const judge = keyPart(f.judge);
  const home = judgeHome(f);
  const line = f.expectation_text?.trim() ? `"${lineWords(f.expectation_text)}"` : f.expectation?.trim() || null;
  const own = f.finding?.trim() ? `:${keyPart(f.finding)}` : "";
  if (answer === "misread") {
    return { against: "judge", key: `judge:${home}:${judge}${own}`, kind: "prompt_miss", title: line ? `The ${f.judge} judge marks good work as breaking ${line}` : `The ${f.judge} judge misreads what it is shown`, part: `the ${f.judge} judge's prompt` };
  }
  if (f.moment && f.moment_kind) {
    return { against: "extractor", key: `extractor:${f.moment_source ? `${keyPart(f.moment_source)}:` : ""}${keyPart(f.moment_kind)}${own}`, kind: "bug", title: line ? `The ${f.moment_kind} moments leave out a fact needed to judge ${line}` : `The ${f.moment_kind} moments leave out facts a judge needs`, part: `the ${f.moment_kind} extractor` };
  }
  return { against: "input", key: `judge-input:${home}:${judge}${own}`, kind: "bug", title: line ? `The ${f.judge} judge is not shown a fact needed to judge ${line}` : `The ${f.judge} judge is not shown a fact it needs`, part: `what the ${f.judge} judge is shown` };
}

/**
 * One case as grouping reads it beside its siblings: the moment, the part at
 * fault, the line ruled on, the diagnosed fact and why the judge missed it
 * (the lines after the fact, which name what hid it: a fold, a cap, a rule).
 * Two cases are one problem when one fix to one kind of part answers both,
 * which the fact and its why say and the judge's original wording does not.
 */
export function caseGist(c: { moment?: string; part?: string; expectation?: string; detail_md?: string }): string {
  const after = c.detail_md?.split(/^The fact: /m)[1];
  const [fact, ...rest] = (after ?? "").split("\n");
  const why = rest.join(" ").replace(/\s+/g, " ").trim();
  const head = [c.moment, c.part, c.expectation].filter(Boolean).join(" · ");
  return `${head}${fact?.trim() ? ` · fact: ${fact.trim().slice(0, 300)}` : ""}${why ? ` · why: ${why.slice(0, 300)}` : ""}`;
}

/** The case's own words: what the judge said, why it was wrong, and what the diagnosis found. */
export function caseDetail(c: {
  judge: string;
  judge_version?: string;
  finding_short_id: string;
  finding_title: string;
  finding_detail?: string;
  trigger: "label" | "dissolve";
  note?: string;
  sentence?: string;
  answer: CaseAnswer;
  fact?: string;
  why?: string;
}): string {
  const lines = [
    `The ${c.judge} judge${c.judge_version ? ` (version ${c.judge_version})` : ""} found: ${c.finding_title} (${c.finding_short_id})`,
  ];
  if (c.finding_detail) lines.push("", c.finding_detail.slice(0, 2000));
  lines.push("", c.trigger === "label"
    ? `A person marked this finding wrong${c.note ? `: "${c.note}"` : "."}`
    : "A line run's proof found the system behaved well and the judge scored it as a break.");
  if (c.sentence) lines.push(`What a correct judgment of this moment does: ${c.sentence}`);
  lines.push("", c.answer === "missing"
    ? "Diagnosis: the fact the judge needed was missing from what it saw."
    : "Diagnosis: the fact the judge needed was in what it saw, and it misread it.");
  if (c.fact) lines.push(`The fact: ${c.fact}`);
  if (c.why) lines.push(c.why);
  return lines.join("\n");
}

/** A finding's judge_review as the CLI and the web read it. */
export type JudgeReviewView = {
  trigger: "label" | "dissolve";
  state: "waiting" | "diagnosing" | "diagnosed" | "failed";
  note?: string;
  sentence?: string;
  waiting_on?: string;
  answer?: "missing" | "misread" | "upheld";
  fact?: string;
  why?: string;
  against?: "judge" | "input" | "extractor";
};

const AGAINST_WORDS: Record<NonNullable<JudgeReviewView["against"]>, string> = {
  judge: "the judge's prompt",
  input: "what the product shows the judge",
  extractor: "the moment's extractor",
};

/** One line on where a wrong finding's diagnosis stands. */
export function judgeReviewLine(r: JudgeReviewView): string {
  const how = r.trigger === "label" ? "marked wrong" : "found wrong by a line run";
  if (r.state === "diagnosed" && r.answer === "upheld") return `${how}; the records show the finding holds${r.why ? `: ${r.why}` : ""}`;
  if (r.state === "diagnosed") {
    return `${how}; ${r.answer === "missing" ? "the fact the judge needed was missing from what it saw" : "the judge misread what it saw"}; filed against ${AGAINST_WORDS[r.against ?? "judge"]}${r.fact ? `. Fact: ${r.fact}` : ""}`;
  }
  if (r.state === "diagnosing") return `${how}; being diagnosed`;
  return `${how}; ${r.state === "failed" ? "the diagnosis failed" : "waiting to be diagnosed"}${r.waiting_on ? `. ${r.waiting_on}` : ""}`;
}


/** The prefixes caseRoute keys a case under (by part, or by the expectation it rules on); a split keeps its prefix. */
const CASE_KEY = /^(?:judge|judge-input|extractor|expectation):/;

/** Whether an issue key is one a case against a judge files under (caseRoute). */
export function isJudgeCaseKey(key: string): boolean {
  return CASE_KEY.test(key.trim());
}

/**
 * Whether a problem holds cases against a judge rather than a product's
 * failure (LL11): every key it gathers is a case key. Such a problem runs the
 * judge route: its fix is a judge's prompt, an extractor or an expectation,
 * proven by an A/B on the ruled moments and shipped by publishing the
 * judges; never the product's change line, and never closed as "the judge
 * was wrong", which is what it is about.
 */
export function isJudgeProblem(cause: { fingerprints?: string[]; issue_key?: string } | null | undefined): boolean {
  const keys = [...(cause?.fingerprints ?? []), ...(cause?.issue_key ? [cause.issue_key] : [])];
  return keys.length > 0 && keys.every(isJudgeCaseKey);
}
