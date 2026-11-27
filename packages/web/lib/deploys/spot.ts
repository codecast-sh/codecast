// Where the change a link names stands on one target of the Deploys page (ct-98574), for its focus chip: the deploy
// that carries it; else its place among the commits waiting since the live deploy and the one thing that holds it
// there; else, off main, where its Ship run stopped or waits, or what its open pull request waits on when no run carries
// it. A change the page can place is never "not here" without
// a reason. Pure: no store, no React.
import type { ShippingRun } from "@codecast/shared/contracts/deployTargets";
import type { ReachState } from "@codecast/shared/contracts/deployReach";
import { prState, runState, stepper, stepsFor, type BoardQueueCommit, type OpenPr } from "./board";
import { commitMatches, deployMatches, prMatches, runMatches, type DeployFocus } from "./focus";
import { isGoing, isOpen, openOf, supersededBy, type DeployTargetRow, type TeamDeployRow } from "./targets";

/** What keeps a waiting change from going out, the first that applies. */
export type Held =
  | { kind: "paused" }
  /** The newest deploy that tried to take it out failed. */
  | { kind: "failed"; deploy: string }
  /** A deploy of older commits is going out first; the change goes in the one after. */
  | { kind: "behind"; deploy: string }
  /** A deploy is open on the target at a commit the queue cannot place (none yet, or one it does not list): it holds
   *  the press, and nobody can say whether it carries the change. */
  | { kind: "open"; deploy: string; going: boolean }
  /** Main's CI on what a deploy would send: red, or still running on a target that goes out on green. */
  | { kind: "ci"; ci: "failed" | "running"; url: string | null }
  /** Nothing goes out until someone presses Deploy. */
  | { kind: "press" }
  | { kind: "no_machine" };

/** How a deploy holds the change: live in the one running now, out in an earlier one, going, asked for, failed, cancelled,
 *  rolled back off, or asked for before the live deploy and never sent (superseded). */
export type HoldWord = "live" | "went_out" | "going" | "asked" | "failed" | "cancelled" | "rolled_back" | "superseded";

export type Spot =
  /** A deploy holds it (or, for a deploy link, is it). */
  | { kind: "deploy"; deploy: string; word: HoldWord }
  /** On main, not out yet: `place` counts it among the `of` commits waiting since `since` (oldest first), null when the queue does not list it. */
  | { kind: "waiting"; place: number | null; of: number; since: string | null; held: Held | null }
  /** Not on main: its Ship run, and the words for where that run is. */
  | { kind: "run"; run: ShippingRun; word: string; dropped: boolean }
  /** Not on main, and no Ship run carries it: an open pull request, and what it waits on. */
  | { kind: "pr"; pr: OpenPr; word: string }
  | { kind: "reading" }
  | { kind: "absent" };

export type SpotInput = {
  focus: DeployFocus;
  target: Pick<DeployTargetRow, "policy" | "runs" | "can_deploy" | "queue">;
  /** The queue's commits, newest on main first (board queueCommits). */
  queue: ReadonlyArray<BoardQueueCommit>;
  /** The target's deploys, newest first. */
  history: ReadonlyArray<TeamDeployRow>;
  live: TeamDeployRow | null;
  /** The deploys a link's thing is on: the one reach names, else those whose records carry it. */
  focusDeploys: ReadonlyArray<TeamDeployRow>;
  /** Reach's word for this target (a PR or commit link), when the server has answered. */
  reach: { short_id: string; state: ReachState } | null;
  paused: boolean;
  /** Shipping's runs on this repository; null while they are read. */
  shipping: { moving: ReadonlyArray<ShippingRun>; dropped: ReadonlyArray<ShippingRun> } | null;
  shippingError?: boolean;
  /** The repository's open pull requests no run carries (board openPrs); null while they are read. */
  openPrs?: ReadonlyArray<OpenPr> | null;
};

const REACH_WORD: Record<Exclude<ReachState, "waiting" | "failed">, HoldWord> = { live: "live", going_out: "going", queued: "asked", rolled_back: "rolled_back" };

/** A deploy's own state as the chip words it: live (the one running now), went out (an earlier one), going, asked,
 *  failed, cancelled; an open one asked for before the live deploy never went out (targets targetNow reads it so too). */
export function holdWord(d: Pick<TeamDeployRow, "_id" | "status" | "sha" | "created_at">, live: Pick<TeamDeployRow, "_id" | "created_at"> | null): HoldWord {
  if (d.status === "live") return d._id === live?._id ? "live" : "went_out";
  if (isOpen(d) && supersededBy(d, live)) return "superseded";
  // A request with no commit carries nothing out (the deploy card's pill reads it the same way).
  if (isGoing(d)) return "going";
  return d.status === "failed" || d.status === "cancelled" ? d.status : "asked";
}

export function changeSpot(i: SpotInput): Spot {
  const { focus: f, target: t, queue } = i;
  const first = i.focusDeploys[0];
  if (f.kind === "deploy") return first ? { kind: "deploy", deploy: first.short_id, word: holdWord(first, i.live) } : { kind: "absent" };
  const r = i.reach;
  // Reach says a deploy holds it (the server places each deploy on main): live, rolled back off, going out or asked for.
  if (r && r.state !== "waiting" && r.state !== "failed") return { kind: "deploy", deploy: r.short_id, word: REACH_WORD[r.state] };
  const mine = queue.filter((c) => commitMatches(c, f));
  // The deploy open on the target now, as targetNow reads it: one asked for before the live deploy never sends anything.
  const open = openOf(i.history, i.live);
  if (open && openTakes(open, queue, mine)) return { kind: "deploy", deploy: open.short_id, word: "going" };
  if (mine.length || r) {
    const unlisted = Math.max(0, t.queue.commits - t.queue.shown);
    const place = mine.length ? unlisted + queue.length - queue.indexOf(mine[0]) : null;
    return { kind: "waiting", place, of: t.queue.commits, since: i.live?.short_id ?? null, held: heldBy(i, open) };
  }
  if (first) return { kind: "deploy", deploy: first.short_id, word: holdWord(first, i.live) };
  const moving = i.shipping?.moving.find((x) => runMatches(x, f));
  const run = moving ?? i.shipping?.dropped.find((x) => runMatches(x, f));
  if (run) return { kind: "run", run, word: runWord(run), dropped: !moving };
  const pr = i.openPrs?.find((p) => prMatches(p, f));
  if (pr) return { kind: "pr", pr, word: prState(pr).word };
  // Still looking while the runs, or the open PRs (null, not left out), are being read.
  return (!i.shipping && !i.shippingError) || i.openPrs === null ? { kind: "reading" } : { kind: "absent" };
}

function heldBy(i: SpotInput, open: TeamDeployRow | null): Held | null {
  const t = i.target;
  if (i.paused) return { kind: "paused" };
  // A deploy open now holds the press: one at an older commit the queue lists goes first; one the queue cannot place
  // (no commit yet, or one it does not list) is named for what it is, never as carrying the change.
  if (open) return open.sha && i.queue.some((c) => sameSha(c.sha, open.sha!)) ? { kind: "behind", deploy: open.short_id } : { kind: "open", deploy: open.short_id, going: isGoing(open) };
  // The newest try that carried it since the live deploy: reach names it, else the records that list the change.
  const tried = i.reach?.state === "failed" ? i.reach.short_id
    : i.history.find((d) => d.status === "failed" && (!i.live || d.created_at > i.live.created_at) && deployMatches(d, i.focus))?.short_id;
  if (tried) return { kind: "failed", deploy: tried };
  if (t.runs === "push") return null;
  if (t.queue.head_ci === "failed") return { kind: "ci", ci: "failed", url: t.queue.head_ci_url };
  if (t.policy === "auto" && t.queue.head_ci === "running") return { kind: "ci", ci: "running", url: t.queue.head_ci_url };
  if (!t.can_deploy) return { kind: "no_machine" };
  return t.policy === "auto" ? null : { kind: "press" };
}

/** Where a Ship run is, in the words its card says: the step it stopped at, else its state now. */
export function runWord(r: ShippingRun): string {
  const s = runState(r);
  if (r.status !== "failed") return s.word;
  const at = stepper(r).indexOf("failed");
  return at >= 0 ? `Stopped at ${stepsFor(r)[at].word}` : s.word;
}

/**
 * Which targets a link's change is on, for the page's target rail: by its reach when the server has answered (a PR or
 * commit), else by what each target's queue and deploys hold. Empty when nothing places it, so the rail stays as is.
 */
export function focusTargets(targets: ReadonlyArray<Pick<DeployTargetRow, "name" | "repository" | "queue">>, deploys: ReadonlyArray<TeamDeployRow>, f: DeployFocus | null, reach: { targets: ReadonlyArray<{ target: string }> } | null): Set<string> {
  if (!f) return new Set();
  if (reach?.targets.length) return new Set(reach.targets.map((r) => r.target));
  const on = targets.filter((t) => t.queue.groups.some((g) => g.commits.some((c) => commitMatches(c, f)))
    || deploys.some((d) => d.target === t.name && (!d.repository || !t.repository || d.repository === t.repository) && deployMatches(d, f)));
  return new Set(on.map((t) => t.name));
}

/**
 * Whether a deploy still open on a target takes these waiting commits out: its commit is at or after each of them on
 * main. The queue is the only place on main this side knows, so the deploy's commit must be one it lists (the queue's
 * order is main's). Anything else is unknown and claims nothing: a request with no commit yet, a rollback or redeploy
 * of an older commit, or a commit past the listed ones. Reach (the server's cut_at) answers for a PR or commit link.
 */
export function openTakes(open: Pick<TeamDeployRow, "sha" | "status"> | null | undefined, queue: ReadonlyArray<Pick<BoardQueueCommit, "sha">>, commits: ReadonlyArray<Pick<BoardQueueCommit, "sha">>): boolean {
  if (!open || !isGoing(open) || !open.sha || !commits.length) return false;
  const at = queue.findIndex((c) => sameSha(c.sha, open.sha!));
  return at >= 0 && commits.every((c) => queue.findIndex((q) => q.sha === c.sha) >= at);
}

const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));
