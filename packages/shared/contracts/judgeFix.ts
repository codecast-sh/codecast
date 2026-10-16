// The judge route's card (docs/architecture/learning-loop.md LL11): a
// problem that gathers cases against a judge is fixed in the judge's prompt,
// its extractor or the expectation it grades against, never in the product.
// Before the fix ships (`cast line moments publish`), it is measured: the
// moments the cases were ruled on are judged again by the edited copy and by
// what is published now, the same number of times each, and so are moments
// whose live findings the judge should keep finding. This card is what the
// project's reviewer reads to publish it or not. Pure, so the CLI that
// measures, the server that stores and the web that draws it agree.

import type { CaseTarget } from "./judgeReview";

/** One group of the A/B: how many of its judge runs found the expectation, before and after the edit. */
export type JudgeFixGroup = {
  /** Moments in the group. */
  moments: number;
  /** Judge runs per arm (moments x reps, less failed calls). */
  runs: number;
  /** Runs that found the group's expectation, on what is published now. */
  base: number;
  /** The same, on the edited copy. */
  arm: number;
  /** One-sided Fisher exact p in the direction the group wants; null when nothing differs. */
  p: number | null;
  /** The distinct messages the group counts, when it counts each message once however many moments show it (the ruled group). */
  messages?: number;
};

/** few_controls: the ruled cases separate, but too few kept findings ran to show the edit keeps them. */
/** empties_proposal: the edit stops finding what a waiting proposal rests on (JudgeFixRest); that proposal would read "evidence gone" while its own measurement stands. */
export type JudgeFixVerdict = "better" | "not_separated" | "worse" | "few_controls" | "empties_proposal";

/** One ruled case on the card: what the judge said, what a correct judgment does, and how often each arm still says it. */
export type JudgeFixCase = {
  finding: string;
  moment: string;
  expectation: string;
  said: string;
  correct: string;
  base: number;
  arm: number;
  reps: number;
  /** The same message ruled the same way on other moments (a contact's conversation and a match both show one email): one case, not several. */
  twins?: Array<{ moment: string; finding: string }>;
};

/**
 * A live finding a waiting trial proposal rests on (its cited case first, else
 * one of its problem's findings by the same judge), measured by name on both
 * sides: a judge fix that stops finding it empties that proposal, which then
 * reads "evidence gone" next to its own count (tc-44, pl-882).
 */
export type JudgeFixRest = {
  card: string;
  problem: string;
  finding: string;
  moment: string;
  expectation: string;
  base: number;
  arm: number;
  reps: number;
};

/** One kept finding the controls measured: a live finding of the same judge, and how often each side files it again on its moment. */
export type JudgeFixKept = {
  finding: string;
  moment: string;
  expectation: string;
  judge: string;
  base: number;
  arm: number;
  reps: number;
};

/** Whether the edit moved a case: the edited copy files it at most half as often as what is published (5/5 to 4/5 is the same case still filed). */
export const caseMoved = (c: Pick<JudgeFixCase, "base" | "arm">) => c.base > 0 && c.arm * 2 <= c.base;

export type JudgeFixCard = {
  kind: "judge_fix";
  /** The problem the cases gather on (ct-N). */
  problem: string;
  /** The question the reviewer answers, a glance long. */
  question: string;
  /** What the edit makes the judge do, one sentence. */
  change: string;
  /** The part edited, in plain words, and its file. */
  part: { against: CaseTarget; name: string; file: string };
  /** The edited lines, per file: removed, then added. */
  diff: Array<{ file: string; removed: string[]; added: string[] }>;
  ab: {
    reps: number;
    model: string;
    cost_usd: number;
    /** The ruled moments: runs that still find the ruled expectation (lower is better). */
    ruled: JudgeFixGroup;
    /** Moments with live findings of the same judge: runs that find them again (higher is better). */
    controls: JudgeFixGroup;
    verdict: JudgeFixVerdict;
    /** What one judge run costs on each side: an edit that grows what the judge reads costs more on every moment from then on. */
    usd_per_run?: { base: number; arm: number };
    /** The findings waiting proposals rest on, by name; one the edit moves makes the verdict empties_proposal. */
    rests?: JudgeFixRest[];
    /** The controls one by one: which kept findings the edit files more or less often. */
    kept?: JudgeFixKept[];
    /** Live findings of the same judges with the same misreading that nobody ruled on (<dir>/held-out.json): the only cases that show the edit generalizes beyond the ones it was made from. */
    held_out?: JudgeFixGroup & { cases: Array<JudgeFixKept & { why: string }> };
    /** How the ruled cases' requests treated the team's rulings on their own messages. Absent on older runs, which carried them, so their numbers are not comparable. */
    rulings?: "withheld_on_ruled";
  };
  cases: JudgeFixCase[];
  /** Where the measured copy lives on the machine that measured it. */
  dir?: string;
  /** Other judge fixes waiting for their reviewer that this one is measured on top of: they publish first, and if one is not published this fix is measured again. */
  builds_on?: Array<{ card: string; problem: string; files: string[] }>;
};

/** Where the A/B must reach before a reviewer is asked: the ruled cases separated, the controls not worse. */
export const JUDGE_FIX_ALPHA = 0.05;
/** Kept-finding moments the controls need before a separated fix counts as working: on 3 moments a drop of 14/15 to 11/15 reads as no change. */
export const JUDGE_FIX_MIN_CONTROLS = 10;

const lnFact = (() => {
  const memo = [0];
  return (n: number) => {
    for (let i = memo.length; i <= n; i++) memo[i] = memo[i - 1] + Math.log(i);
    return memo[n];
  };
})();

/** Hypergeometric probability of a hits among n1 draws, k hits in n1 + n2. */
function hyper(a: number, n1: number, n2: number, k: number): number {
  const lnC = (n: number, r: number) => lnFact(n) - lnFact(r) - lnFact(n - r);
  return Math.exp(lnC(n1, a) + lnC(n2, k - a) - lnC(n1 + n2, k));
}

/**
 * One-sided Fisher exact test that the arm's hit rate is LOWER than the
 * base's (`less`) or HIGHER (`greater`): x hits of n on the arm, y of m on the
 * base. Null when the rates are equal or a side ran nothing.
 */
export function fisherOneSided(x: number, n: number, y: number, m: number, alt: "less" | "greater"): number | null {
  if (n <= 0 || m <= 0 || x * m === y * n) return null;
  const k = x + y;
  const lo = Math.max(0, k - m);
  const hi = Math.min(n, k);
  let p = 0;
  for (let a = lo; a <= hi; a++) if (alt === "less" ? a <= x : a >= x) p += hyper(a, n, m, k);
  return Math.min(1, p);
}

/**
 * The A/B's verdict: better only when the ruled cases separate and the
 * controls, on at least JUDGE_FIX_MIN_CONTROLS moments, do not get worse.
 * A fix that separates on fewer controls is few_controls: the edit may be
 * right, but the measurement cannot say it keeps what the judge finds.
 */
/**
 * Whether the edit takes away what a waiting proposal rests on: its finding is
 * filed less often under the edit by the same one-sided test the ruled cases
 * pass. A rest filed once in five runs is a draw on either side (4/5 to 2/5,
 * 1/5 to 0/5 move nothing), and blocking on one sent working fixes back to
 * be rewritten (ct-60174, 2026-10-16).
 */
export function restEmptied(r: Pick<JudgeFixRest, "base" | "arm" | "reps">): boolean {
  const p = fisherOneSided(r.arm, r.reps, r.base, r.reps, "less");
  return p !== null && p <= JUDGE_FIX_ALPHA;
}

export function judgeFixVerdict(ruled: JudgeFixGroup, controls: JudgeFixGroup, rests: Array<Pick<JudgeFixRest, "base" | "arm" | "reps">> = []): JudgeFixVerdict {
  const worse = controls.runs > 0 && fisherOneSided(controls.arm, controls.runs, controls.base, controls.runs, "less");
  if (worse !== false && worse !== null && worse <= JUDGE_FIX_ALPHA) return "worse";
  if (rests.some(restEmptied)) return "empties_proposal";
  const better = fisherOneSided(ruled.arm, ruled.runs, ruled.base, ruled.runs, "less");
  if (better === null || better > JUDGE_FIX_ALPHA || ruled.arm >= ruled.base) return "not_separated";
  return controls.moments < JUDGE_FIX_MIN_CONTROLS ? "few_controls" : "better";
}

/** A group's counts with its p in the direction it wants. */
export function judgeFixGroup(moments: number, runs: number, base: number, arm: number, wants: "fewer" | "more"): JudgeFixGroup {
  return { moments, runs, base, arm, p: fisherOneSided(arm, runs, base, runs, wants === "fewer" ? "less" : "greater") };
}

export function isJudgeFixCard(raw: unknown): raw is { kind: "judge_fix" } {
  return !!raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "judge_fix";
}

/** What a judge-fix card must carry before a reviewer is asked; the errors say what is missing. */
export function validateJudgeFixCard(raw: unknown): { ok: true; card: JudgeFixCard } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJudgeFixCard(raw)) return { ok: false, errors: ['kind is "judge_fix"'] };
  const c = raw as Partial<JudgeFixCard>;
  if (!/^ct-\d+$/.test(c.problem ?? "")) errors.push("problem names the problem (ct-N)");
  if (!c.question?.trim()) errors.push("question is the one line the reviewer answers");
  if (!c.change?.trim()) errors.push("change says in one sentence what the edit makes the judge do");
  if (!c.part?.file || !c.part?.name) errors.push("part names the edited part and its file");
  if (!Array.isArray(c.diff) || !c.diff.some((d) => d.added?.length || d.removed?.length)) errors.push("diff holds the edited lines");
  if (!c.ab?.ruled || !c.ab?.controls || !c.ab?.verdict) errors.push("ab holds the ruled and control groups and the verdict");
  if (!Array.isArray(c.cases) || !c.cases.length) errors.push("cases holds at least one ruled case");
  return errors.length ? { ok: false, errors } : { ok: true, card: c as JudgeFixCard };
}
