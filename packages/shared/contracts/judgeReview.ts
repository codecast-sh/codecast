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
};

export type CaseRoute = {
  against: CaseTarget;
  /** The issue key every case against this part gathers under: one problem per part. */
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

/**
 * misread files against the judge. missing files against what fed it: the
 * extractor that froze the moment (bring moments), else the product's builder
 * of the judge's input (bring findings). Cases against one part gather into
 * one problem, so a judge collects its cases and its line fixes them together.
 */
export function caseRoute(f: WrongFinding, answer: CaseAnswer): CaseRoute {
  const judge = keyPart(f.judge);
  const home = judgeHome(f);
  if (answer === "misread") {
    return { against: "judge", key: `judge:${home}:${judge}`, kind: "prompt_miss", title: `The ${f.judge} judge misreads what it is shown`, part: `the ${f.judge} judge's prompt` };
  }
  if (f.moment && f.moment_kind) {
    const kind = keyPart(f.moment_kind);
    const from = f.moment_source ? `${keyPart(f.moment_source)}:` : "";
    return { against: "extractor", key: `extractor:${from}${kind}`, kind: "bug", title: `The ${f.moment_kind} moments leave out facts a judge needs`, part: `the ${f.moment_kind} extractor` };
  }
  return { against: "input", key: `judge-input:${home}:${judge}`, kind: "bug", title: `The ${f.judge} judge is not shown a fact it needs`, part: `what the ${f.judge} judge is shown` };
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

