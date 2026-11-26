// The change flow's Verdicts station (flows.md FL4): `cast flow verdicts`
// says where a round's CI and review send the run. CI's verdict is ci.json,
// which a command station wrote on the run's machine. The reviewer's verdict
// is what its session pinned, passed in by the graph, and it counts only when
// it carries this round's nonce from pr.json and names the head CI judged, or
// one the run's own stations rebased into it: a file any process could write,
// the change's own author included, never counts, and neither does a pin from
// an earlier round or on a head pushed since. A round that pushed the head a
// reviewer already said ship on asks no reviewer: the PR station carries that
// ship into pr.json (`reviewed`) from what the server recorded in this attempt,
// and it stands for the round only while the server still holds it, as Merge
// requires. Only green CI on the pushed head and an accepted `ship` merge;
// what only the machine can fix runs again once in the round; the rest goes
// back to the session, never on to Merge.
import * as fs from "node:fs";
import * as path from "node:path";
import type { MergeProof } from "./prStation.js";

export type Verdicts = {
  /** CI and the review as the run card shows them. */
  ci: "green" | "red" | "blocked_by_main" | "timed_out";
  review: "ship" | "changes" | "rejected" | "missing" | "stale";
  next: "merge" | "brief" | "rejected" | "rerun_ci" | "rerun_review" | "no_ci" | "wait_main" | "decide" | "conflict" | "new_round";
  /** Why, in words a session or a stop message can carry. */
  why: string;
  /** ci.json with only the failures the change causes, the first of them cut short (the whole report is ci.json). */
  ci_result: Record<string, any> | null;
  /** The review as accepted for this round, null when none was; `reused` when it is the reviewer's ship from an earlier round on this head. */
  review_result: Record<string, any> | null;
  /**
   * Whether a brief asks the session to change its code: CI judged the pushed head red with anything not every failure
   * main also has (failures it names nobody, too), or this round's reviewer asked for changes. Only such a brief spends
   * one of the session's rounds (change.cast); one only for a review that never arrived does not.
   */
  fix: boolean;
};

const REVIEW_VERDICTS = ["ship", "changes", "rejected"];
/** Each machine step runs once more per round before the round gives up on it. */
const RERUNS = 1;
/** The CI station's own entry in `failing`: it timed out, or could not judge. That is the machine's, never the change's. */
const STATION_JOB = "ci-station";
// What the station prints stays small: the brief shows these many failures, each excerpt cut, and the why cut.
const SHOWN_FAILURES = 10;
const EXCERPT_CAP = 600;
const WHY_CAP = 2000;

function parse(text: string | undefined): Record<string, any> | null {
  try {
    const v = JSON.parse(text ?? "");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
const readJson = (file: string) => parse(fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined);
const words = (list: unknown[]) => list.map((f) => (typeof f === "string" ? f : JSON.stringify(f))).join("; ");
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * The heads a review of the head CI judged speaks for: that head, and every head the run's own stations rebased it
 * from this round (pr.json's `rebases`, {from, to}, recorded when Merge rebased for a retest or the change went onto a
 * green main). A head anyone else pushed is in no such chain.
 */
export function reviewedHeads(ciHead: unknown, rebases: unknown): Set<string> {
  const heads = new Set<string>();
  const chain = Array.isArray(rebases) ? (rebases as Array<{ from?: unknown; to?: unknown }>) : [];
  for (let h = typeof ciHead === "string" ? ciHead : ""; h && !heads.has(h); ) {
    heads.add(h);
    const step = chain.find((r) => r.to === h);
    h = typeof step?.from === "string" ? step.from : "";
  }
  return heads;
}

/** Why a reviewer's pin is not this round's verdict on the change CI judged, or null when it is. */
function reviewProblem(pin: Record<string, any> | null, round: unknown, heads: Set<string>): string | null {
  if (!pin) return "the reviewer pinned no verdict";
  if (!round || pin.round !== round) return "the reviewer's verdict is not this round's";
  if (typeof pin.head_sha !== "string" || !heads.has(pin.head_sha)) return `the reviewer's verdict is for ${String(pin.head_sha ?? "no commit").slice(0, 10)}, not the head CI judged`;
  if (!REVIEW_VERDICTS.includes(pin.verdict)) return `the reviewer's verdict "${String(pin.verdict ?? "")}" is not ship, changes or rejected`;
  return null;
}

/**
 * Decide, and leave the run's directory saying so: pr.json counts the round's reruns, and review.json holds the
 * accepted review (the one Merge reads), or nothing when no review was accepted. `proof` is what the server holds for
 * the run's attempt: a carried review counts only when it is the reviewer's ship the server recorded on that head.
 */
export function changeVerdicts(dir: string, reviewPin: string | undefined, originHead?: string | null, proof?: MergeProof | null): Verdicts {
  const prFile = path.join(dir, "pr.json");
  const pr = readJson(prFile);
  const done = (v: Omit<Verdicts, "why" | "fix"> & { why: string }): Verdicts => ({ ...v, why: v.why.slice(0, WHY_CAP), fix: v.next === "brief" && fix });
  const ci = readJson(path.join(dir, "ci.json"));
  const heads = reviewedHeads(ci?.head_sha, pr?.rebases);
  // A reviewer's pin with this round's nonce comes first. Without one, the ship the PR station carried stands, only
  // while the server still records that ship on that head in this attempt and CI judged a head it speaks for.
  const pin = parse(reviewPin);
  const pinProblem = reviewProblem(pin, pr?.round, heads);
  const carried = pr?.reviewed?.verdict === "ship" && typeof pr.reviewed.head_sha === "string" ? pr.reviewed.head_sha as string : null;
  const reused = pinProblem && carried && heads.has(carried) && proof?.review?.verdict === "ship" && proof.review.head_sha === carried;
  const review = !pinProblem
    ? { verdict: pin!.verdict, findings: Array.isArray(pin!.findings) ? pin!.findings : [], round: pin!.round, head_sha: pin!.head_sha }
    : reused ? { verdict: "ship", findings: [], head_sha: carried, reused: true } : null;
  const problem = review ? null : carried ? `the ship carried for ${carried.slice(0, 10)} is not one the server holds on the head CI judged in this attempt, and ${pinProblem}` : pinProblem;
  const reviewFile = path.join(dir, "review.json");
  if (review) fs.writeFileSync(reviewFile, JSON.stringify(review, null, 2) + "\n");
  else fs.rmSync(reviewFile, { force: true });

  const rerun = (key: "ci_reruns" | "review_reruns") => {
    const used = Number(pr?.[key] ?? 0);
    if (!pr || used >= RERUNS) return false;
    fs.writeFileSync(prFile, JSON.stringify({ ...pr, [key]: used + 1 }, null, 2) + "\n");
    return true;
  };

  const failing: Array<Record<string, any>> = Array.isArray(ci?.failing) ? ci!.failing : [];
  const station = failing.filter((f) => f?.job === STATION_JOB);
  const real = failing.filter((f) => f?.job !== STATION_JOB);
  const pending: string[] = Array.isArray(ci?.pending) ? ci!.pending : [];
  const stationSaid = (f: Record<string, any>) => [f.assertion, f.excerpt].filter((s) => typeof s === "string" && s).join(": ") || "no reason";
  // GitHub runs no CI on a pull request that conflicts with its base: the station says so, and only the session can fix it.
  const conflict = station.find((f) => /merge conflict/i.test(stationSaid(f)));
  // What only the machine can fix: CI that never answered, answered for another head, or could not judge.
  const machine = !ci ? "CI left no ci.json"
    : !pr?.head_sha || ci.head_sha !== pr.head_sha ? `CI judged ${String(ci.head_sha ?? "no commit").slice(0, 10)}, not the pushed head ${String(pr?.head_sha ?? "unknown").slice(0, 10)}`
    : ci.timed_out === true ? `CI did not finish${pending.length ? `: ${pending.join(", ")} still running` : ""}`
    : station.length ? `the CI station could not judge: ${station.map(stationSaid).join("; ")}`
    : null;
  const passing = !!ci && !machine && !real.length && ci.green === true;
  // CI that judged the pushed head red asks for a fix unless every failure is main's; one naming no failure counts too.
  const ciAsks = !!ci && ci.head_sha === pr?.head_sha && !passing && (!machine || real.length > 0) && !(ci.blocked_by_main === true && !real.length);
  const fix = ciAsks || review?.verdict === "changes";
  const said = {
    ci: (machine && !conflict ? "timed_out" : passing ? "green" : ci?.blocked_by_main === true ? "blocked_by_main" : "red") as Verdicts["ci"],
    review: (review ? review.verdict : pin || carried ? "stale" : "missing") as Verdicts["review"],
    ci_result: ci ? briefed(ci, real) : null,
    review_result: review,
  };

  // Someone pushed to the branch after this round's push: whatever CI and the reviewer said was about another head.
  if (originHead && pr?.head_sha && originHead !== pr.head_sha) {
    return done({ ...said, next: "new_round", why: `the branch moved to ${originHead.slice(0, 10)} after this round pushed ${String(pr.head_sha).slice(0, 10)}` });
  }
  if (review?.verdict === "rejected") return done({ ...said, next: "rejected", why: words(review.findings) || "the reviewer gave no reasons" });
  if (conflict && ci?.head_sha === pr?.head_sha) return done({ ...said, next: "conflict", why: stationSaid(conflict) });
  if (machine) {
    if (rerun("ci_reruns")) return done({ ...said, next: "rerun_ci", why: machine });
    // Out of reruns: failures the change causes, judged on the pushed head beside the station's own, go to the session.
    const judged = !!ci && ci.head_sha === pr?.head_sha;
    if (!real.length || !judged) return done({ ...said, next: "no_ci", why: machine });
  }
  // Every failure also fails on main: nothing in them is the change's to fix, so the run waits for main, unless the
  // reviewer gave the session something to do meanwhile.
  if (!passing && !machine && ci!.blocked_by_main === true && review?.verdict !== "changes") {
    return done({ ...said, next: "wait_main", why: `every CI failure also fails on main (${real.length})` });
  }
  // CI cannot vouch for a change to CI itself: green, and the reviewer says ship, a person decides.
  if (passing && ci!.ci_changed === true && review?.verdict === "ship") return done({ ...said, next: "decide", why: "This change edits CI, so CI can't vouch for it" });

  const back: string[] = [];
  if (!passing) back.push(`CI is red: ${plural(real.length, "failure")} this change causes`);
  if (problem) {
    // A review that never arrived is the machine's to ask again, as long as CI leaves the session nothing to fix.
    if (!back.length && rerun("review_reruns")) return done({ ...said, next: "rerun_review", why: problem });
    back.push(problem);
  } else if (review!.verdict === "changes") back.push(`the reviewer asked for changes${review!.findings.length ? `: ${words(review!.findings)}` : ""}`);
  if (back.length || ci!.green !== true) return done({ ...said, next: "brief", why: back.join("; ") || "CI is not green" });
  return done({ ...said, next: "merge", why: "CI is green on the pushed head and the reviewer said ship" });
}

/**
 * ci.json as the brief shows it inline, small enough for the station's output (the runner keeps a node's JSON only up
 * to 64KB): the change's own failures, the first ones only and each excerpt cut, with how many there are. The whole
 * report stays in ci.json in the run's directory.
 */
function briefed(ci: Record<string, any>, real: Array<Record<string, any>>): Record<string, any> {
  const cut = (list: unknown) => (Array.isArray(list) ? list : []).slice(0, SHOWN_FAILURES).map((f: any) => ({ ...f, excerpt: typeof f?.excerpt === "string" ? f.excerpt.slice(0, EXCERPT_CAP) : f?.excerpt }));
  return { ...ci, failing: cut(real), failing_count: real.length, preexisting: cut(ci.preexisting) };
}
