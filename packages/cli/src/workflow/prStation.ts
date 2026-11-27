// The change flow's PR station (flows.md FL4): `cast flow pr` starts a round.
// It clears the last round's verdict files, pushes the run's change branch and
// opens its pull request, or finds the one already open, which the push has
// just updated. It leaves `$run_dir/pr.json` and prints the same JSON, so every
// later station reads `$pr.json.<field>`.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultExec, type Exec } from "../lineMerge.js";
import { reviewedHeads } from "./changeVerdicts.js";
import { chainBetween, recordRebase, type RebaseLink } from "./rebaseRecord.js";
import { readFrozenChange } from "./flowChangeFile.js";
import { unpushedBody } from "./unpushedCommits.js";

/**
 * `round` is a fresh nonce each round: a reviewer pins it with its verdict, and Verdicts counts only a verdict that
 * carries it. `local_sha` is the local branch tip a push came from, when the pushed commits had to be put onto
 * origin's branch first. Verdicts counts the round's reruns here, so a new round starts with none. `rebases` are the
 * round's heads the run's own stations made from the reviewed one, so its review still speaks for them. `reviewed` is
 * the reviewer's ship the server holds for this attempt when this round pushed the head it read: no reviewer is asked.
 */
export type PrRecord = {
  url: string; number: number; head_sha: string; branch: string; round: string;
  local_sha?: string; ci_reruns?: number; review_reruns?: number; rebases?: Array<{ from: string; to: string }>;
  reviewed?: StandingReview;
};

/** The reviewer's ship on a head, as the server recorded it for the run's attempt: what a round on that head reuses. */
export type StandingReview = { verdict: "ship"; head_sha: string };

/** What the server holds for the run's current attempt (`/cli/workflow-runs/merge-proof`): the review Merge clears on. */
export type MergeProof = {
  review: { verdict: string; head_sha: string } | null;
  rebases?: RebaseLink[];
  /** A person answered Ship on one of the run's own cards in this attempt (what Merge needs for a change to CI). */
  ci_shipped?: boolean;
};

/** `new_round`: origin's branch moved by someone other than the run's stations, so the round's review no longer stands. */
export type PrStationResult = { ok: true; pr: PrRecord } | { ok: false; reason: string; new_round?: true };

/** What a round's stations leave in the run's directory. Each round judges only its own. */
export const ROUND_FILES = ["ci.json", "review.json", "merge.json", "rebase.json"];

const firstLine = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
/** What git push says went wrong ("! [rejected] … (fetch first)", "error: …"), without its "To <remote>" line and its hints. */
const lastLines = (r: { stdout: string; stderr: string }) =>
  (r.stderr || r.stdout).trim().split("\n").map((l) => l.trim()).filter((l) => l && !/^(hint:|To )/.test(l)).slice(-3).join(" | ");

export function readPr(dir: string): PrRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "pr.json"), "utf-8")) as PrRecord;
  } catch {
    return null;
  }
}

export function writePr(dir: string, pr: PrRecord): PrRecord {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pr.json"), JSON.stringify(pr, null, 2) + "\n");
  return pr;
}

/** `local`'s commits since `from`, replayed onto `onto` in a scratch worktree: the new tip, or why they do not apply. */
function replay(exec: Exec, cwd: string, onto: string, from: string, local: string): { sha: string } | { reason: string } {
  const at = fs.mkdtempSync(path.join(os.tmpdir(), "cast-flow-pr-"));
  try {
    const add = exec("git", ["worktree", "add", "--quiet", "--detach", at, onto], cwd);
    if (add.status !== 0) return { reason: `could not make a worktree to replay in: ${firstLine(add)}` };
    const pick = exec("git", ["cherry-pick", "--allow-empty", `${from}..${local}`], at);
    if (pick.status !== 0) {
      const conflicted = exec("git", ["diff", "--name-only", "--diff-filter=U"], at).stdout.trim().split("\n").filter(Boolean);
      exec("git", ["cherry-pick", "--abort"], at);
      return { reason: conflicted.length ? `they conflict with it in ${conflicted.join(", ")}` : firstLine(pick) };
    }
    return { sha: exec("git", ["rev-parse", "HEAD"], at).stdout.trim() };
  } finally {
    exec("git", ["worktree", "remove", "--force", at], cwd);
    fs.rmSync(at, { recursive: true, force: true });
  }
}

/**
 * The review that stands for the head this round pushes: the reviewer's ship the server recorded in this attempt (the
 * one Merge clears on, never a file in the run's directory), when the head is the one it read or one the run's own
 * recorded station rebases made from it, whose links come along. A review binds to the head it read, so a round on
 * that head asks no reviewer again. Null for any other head, a changes verdict (a fresh reviewer reads the head
 * again), no proof, or a review from an earlier attempt, which the server no longer counts.
 */
export function standingReview(proof: MergeProof | null | undefined, head: string): { reviewed: StandingReview; rebases?: RebaseLink[] } | null {
  const review = proof?.review;
  if (review?.verdict !== "ship" || typeof review.head_sha !== "string" || !review.head_sha) return null;
  const chain = chainBetween(proof?.rebases ?? [], review.head_sha, head);
  if (!chain) return null;
  return { reviewed: { verdict: "ship", head_sha: review.head_sha }, ...(chain.length ? { rebases: chain } : {}) };
}

/** `proof`: what the server holds for the run's attempt, read before the round starts; without it every round is reviewed. */
export function prStation(args: { cwd: string; dir: string; branch: string; base: string; title?: string; body?: string; exec?: Exec; proof?: MergeProof | null }): PrStationResult {
  const exec = args.exec ?? defaultExec;
  const { cwd, dir, branch, base } = args;
  for (const f of ROUND_FILES) fs.rmSync(path.join(dir, f), { force: true });
  const tip = exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], cwd);
  if (tip.status !== 0) return { ok: false, reason: `There is no branch ${branch} here to push.` };
  const sha = tip.stdout.trim();

  // A pull request from a fork has its branch in another repository, and this station pushes only to origin.
  const list = exec("gh", ["pr", "list", "--head", branch, "--base", base, "--state", "open", "--json", "number,url,isCrossRepository", "--limit", "1"], cwd);
  if (list.status !== 0) return { ok: false, reason: `gh pr list failed: ${firstLine(list)}` };
  let open: Array<{ number: number; url: string; isCrossRepository?: boolean }>;
  try { open = JSON.parse(list.stdout || "[]"); } catch { return { ok: false, reason: "gh pr list returned no JSON" }; }
  if (open[0]?.isCrossRepository) return { ok: false, reason: `Pull request ${open[0].url} comes from a fork: the change flow pushes only to origin, so it cannot ship a fork's branch.` };

  const change = readFrozenChange(dir);
  const owned = change?.source === "session" && change.branch === branch;
  const previous = readPr(dir);
  const last = previous?.branch === branch ? previous : null;
  const fetched = exec("git", ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], cwd);
  const remote = fetched.status === 0 ? exec("git", ["rev-parse", `refs/remotes/origin/${branch}`], cwd).stdout.trim() : "";
  const isAncestor = (a: string, b: string) => exec("git", ["merge-base", "--is-ancestor", a, b], cwd).status === 0;
  const tree = (rev: string) => exec("git", ["rev-parse", "--verify", "-q", `${rev}^{tree}`], cwd).stdout.trim();

  // Merge rebases the branch onto main and pushes it when main moved, then CI runs again. Origin's branch is then the
  // change, and the local branch lags it: `from` is the local tip origin's branch stands for.
  const from = last ? last.local_sha ?? last.head_sha : "";
  const moved = !!from && !!remote && remote !== from;
  let head = sha;
  let local: string | undefined;
  if (moved && !!tree(sha) && tree(sha) === tree(from)) {
    // Nothing new since the last push: pushing the local branch would undo the rebase.
    head = remote;
    local = sha;
  } else if (moved && !owned && !isAncestor(remote, sha)) {
    // The session's fix, committed on the lagging local branch, goes onto origin's rebased branch.
    if (!isAncestor(from, sha)) return { ok: false, reason: `${branch} moved on origin and here since this run last pushed it, and the two cannot be told apart.` };
    const put = replay(exec, cwd, remote, from, sha);
    if ("reason" in put) return { ok: false, reason: `Could not put the new commits on ${branch} onto origin's rebased ${branch}: ${put.reason}` };
    head = put.sha;
    local = sha;
  }
  if (head !== remote) {
    // The branch goes up as a fast forward, or by force over exactly the head this run last pushed there: a branch
    // frozen from a session's edits is the run's own (each refreeze cuts a new commit on the checkout's HEAD, and its
    // first push takes what it finds, or nothing once the branch is gone), and a session's fix to someone's branch may
    // have rebased it. A head anyone else pushed is never overwritten.
    const known = last && remote ? (owned || remote === last.head_sha ? last.head_sha : null) : owned ? remote : null;
    const push = exec("git", ["push", ...(known !== null ? [`--force-with-lease=refs/heads/${branch}:${known}`] : []), "origin", `${head}:refs/heads/${branch}`], cwd);
    if (push.status !== 0) return { ok: false, reason: `Could not push ${branch}: ${lastLines(push)}` };
  }

  let url: string;
  let number: number;
  if (open.length) {
    ({ url, number } = open[0]);
  } else {
    const title = args.title?.trim() || change?.title || exec("git", ["log", "-1", "--format=%s", sha], cwd).stdout.trim() || branch;
    // A change frozen from a checkout carries the checkout's unpushed commits: the pull request names them.
    const body = [args.body ?? "", change?.branch === branch ? unpushedBody(change.unpushed) : ""].filter(Boolean).join("\n\n");
    const create = exec("gh", ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], cwd);
    if (create.status !== 0) return { ok: false, reason: `gh pr create failed: ${firstLine(create)}` };
    url = create.stdout.trim().split("\n").pop() ?? "";
    number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!number) return { ok: false, reason: `gh pr create named no pull request: ${url || "it printed nothing"}` };
  }
  const stands = standingReview(args.proof, head);
  return { ok: true, pr: writePr(dir, { url, number, head_sha: head, branch, round: randomUUID(), ...(local ? { local_sha: local } : {}), ...(stands ?? {}) }) };
}

const newRound = (branch: string, remote: string, ours: string): PrStationResult => ({
  ok: false,
  new_round: true,
  reason: `origin's ${branch} is at ${remote.slice(0, 10)}, not ${ours.slice(0, 10)}, which this run's stations made: a new round reviews what is there`,
});

/** A head the run's own stations made from the reviewed one: the round, its review and its record of rebases go on. */
function rebased(dir: string, last: PrRecord, from: string, to: string): PrStationResult {
  for (const f of ["ci.json", "merge.json"]) fs.rmSync(path.join(dir, f), { force: true });
  const rebases = from === to ? last.rebases ?? [] : [...(last.rebases ?? []), { from, to }];
  return { ok: true, pr: writePr(dir, { ...last, head_sha: to, local_sha: last.local_sha ?? last.head_sha, rebases }) };
}

/** The round's heads, newest first: its head now back through each station rebase to the head its reviewer read. */
const roundHeads = (last: PrRecord) => [...reviewedHeads(last.head_sha, last.rebases)];

/**
 * After main went green again under a change CI could not judge: origin's branch goes onto origin's `base` and is
 * pushed, so CI tests the change on the new main. The round and its review stand, since the change is the same: the
 * rebase is recorded as Merge records its own (rebaseRecord.ts), on the server and in rebase.json, and Merge checks
 * it is a real rebase. A branch someone pushed to since the round's review starts a new round instead.
 */
export async function rebasePr(args: { cwd: string; dir: string; base: string; runId: string; post: (route: string, body: Record<string, unknown>) => Promise<unknown>; exec?: Exec }): Promise<PrStationResult> {
  const exec = args.exec ?? defaultExec;
  const { cwd, dir, base } = args;
  const last = readPr(dir);
  if (!last) return { ok: false, reason: "No pr.json in the run's directory: the PR station runs first." };
  const { branch } = last;
  const fetched = exec("git", ["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], cwd);
  if (fetched.status !== 0) return { ok: false, reason: `Could not fetch ${base} and ${branch} from origin: ${firstLine(fetched)}` };
  const rev = (ref: string) => exec("git", ["rev-parse", ref], cwd).stdout.trim();
  const remote = rev(`refs/remotes/origin/${branch}`);
  if (remote !== last.head_sha) return newRound(branch, remote, last.head_sha);
  const onto = rev(`refs/remotes/origin/${base}`);
  const fork = exec("git", ["merge-base", remote, onto], cwd).stdout.trim();
  const put = fork === onto ? { sha: remote } : replay(exec, cwd, onto, fork, remote);
  if ("reason" in put) return { ok: false, reason: `${branch} does not go onto ${base} at ${onto.slice(0, 10)}: ${put.reason}` };
  if (put.sha === remote) return rebased(dir, last, remote, remote);
  const push = exec("git", ["push", `--force-with-lease=refs/heads/${branch}:${remote}`, "origin", `${put.sha}:refs/heads/${branch}`], cwd);
  if (push.status !== 0) return { ok: false, reason: `Could not push ${branch} rebased onto ${base}: ${lastLines(push)}` };
  // Unrecorded, the rebased head is one nobody reviewed: Merge refuses it and the round asks for a review again.
  try { await recordRebase({ post: args.post, runId: args.runId, runDir: dir, from: remote, to: put.sha }); }
  catch (err) { return { ok: false, reason: `Could not record the rebase of ${branch} onto ${base}: ${err instanceof Error ? err.message : String(err)}` }; }
  return rebased(dir, last, remote, put.sha);
}

/**
 * After Merge pushed the branch rebased for a retest ($run_dir/rebase.json, {from, to}): the pull request's head is
 * origin's branch now. The round and its review stand only when origin holds exactly the rebase a station made from
 * one of the round's heads (Merge records it from the head the reviewer read); any other head was pushed by someone
 * else, and a new round reviews it.
 */
export function refreshPr(args: { cwd: string; dir: string; exec?: Exec }): PrStationResult {
  const exec = args.exec ?? defaultExec;
  const last = readPr(args.dir);
  if (!last) return { ok: false, reason: "No pr.json in the run's directory: the PR station runs first." };
  const remote = exec("git", ["ls-remote", "origin", `refs/heads/${last.branch}`], args.cwd).stdout.trim().split(/\s/)[0] ?? "";
  if (!remote) return { ok: false, reason: `There is no ${last.branch} on origin.` };
  let made: { from?: unknown; to?: unknown } | null = null;
  try { made = JSON.parse(fs.readFileSync(path.join(args.dir, "rebase.json"), "utf-8")); } catch {}
  const to = typeof made?.to === "string" ? made.to : "";
  const from = typeof made?.from === "string" ? made.from : "";
  if (!to || !roundHeads(last).includes(from) || remote !== to) return newRound(last.branch, remote, to || last.head_sha);
  return rebased(args.dir, last, from, remote);
}
