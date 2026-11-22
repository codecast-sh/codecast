// Where a pull request stands in production, as its page reads it
// (deploys.md DP16): a merged one's reach on each target it touches, joined
// with that target's waiting queue and press, and an open one's targets, the
// places it will go once it merges. Pure: no store, no React.
import { DORMANT_TARGET_MS, type DeployReach, type ReachDeployRef, type ReachState, type TargetReach } from "@codecast/shared/contracts/deployReach";
import { commitTouchesTarget, type CommitCiState } from "@codecast/shared/contracts/deployTargets";
import { REACH_LOOK } from "./deployPill";
import { deploysOf, targetNow, type DeployTargetRow, type TeamDeployRow } from "./targets";

/** One target a merged pull request goes to: its reach, and what a reader can do about it there. */
export type PrDeployRow = {
  target: string;
  state: ReachState;
  /** live: the deploy that took it out; going_out / queued: the one taking it; failed: the one that failed; rolled_back: the one it was live in. */
  deploy: ReachDeployRef | null;
  /** What the target runs now, when that is not the change. */
  now: ReachDeployRef | null;
  /** Why the deploy failed, when its record says. */
  note: string | null;
  /** Waiting on main: how many other commits wait with it (at least that many when the scan was cut short; null when
   *  it sits past the listed ones), and CI on what a deploy now would send. */
  queue: { others: number | null; atLeast: boolean; ci: CommitCiState; ciUrl: string | null } | null;
  /** The target a press would send it to, when this viewer can send it now. */
  press: DeployTargetRow | null;
  /** The press's words, or why there is none. */
  pressWords: string | null;
  blocked: string | null;
};

const ATTENTION: Record<ReachState, number> = { failed: 0, rolled_back: 1, waiting: 2, queued: 3, going_out: 4, live: 5 };

const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

const sameRepo = (a: string | null | undefined, b: string) => !a || a.toLowerCase() === b.toLowerCase();

/**
 * Whether a target has gone idle by the rule reach reads (contracts/deployReach `dormant`): nothing asked for or
 * running, and no deploy of any kind in a week. Unknown (no deploys in hand) is not idle.
 */
export function idleByHistory(t: Pick<DeployTargetRow, "name" | "repository">, deploys: ReadonlyArray<TeamDeployRow>, now: number): boolean {
  const mine = deploysOf(t, deploys);
  if (!mine.length || mine.some((d) => d.status === "running" || d.status === "requested")) return false;
  return now - Math.max(...mine.map((d) => d.live_at ?? d.finished_at ?? d.created_at)) > DORMANT_TARGET_MS;
}

/**
 * Whether a target only keeps its row: the server marks it, and a server that predates the mark is read by the same
 * rule from the team's deploys of that target.
 */
export function isDormant(t: TargetReach & { dormant?: boolean }, row: DeployTargetRow | undefined, deploys: ReadonlyArray<TeamDeployRow>, now: number): boolean {
  if (t.dormant) return true;
  return !!row && idleByHistory(row, deploys, now);
}

/** The press a target offers, or why it offers none. */
function pressOf(t: DeployTargetRow | undefined, deploys: ReadonlyArray<TeamDeployRow>): Pick<PrDeployRow, "press" | "pressWords" | "blocked"> {
  if (!t || t.record_only) return { press: null, pressWords: null, blocked: null };
  if (t.runs === "push") return { press: null, pressWords: null, blocked: "Goes out when main moves" };
  const open = targetNow(t, deploys).open;
  if (open) return { press: null, pressWords: null, blocked: `${open.short_id || "A deploy"} is going out` };
  if (!t.can_deploy) return { press: null, pressWords: null, blocked: "No machine publishes it" };
  const n = t.queue.commits;
  if (t.queue.known && n === 0) return { press: null, pressWords: null, blocked: "Nothing waiting" };
  return { press: t, pressWords: !t.queue.known ? "Deploy main" : `Deploy ${n}${t.queue.truncated ? "+" : ""} ${n === 1 ? "commit" : "commits"}`, blocked: null };
}

/**
 * A merged pull request's rows, the one that most needs a reader's eye first, and the targets that only keep their
 * row (shipped nothing in a week) by name. `targets` and `deploys` are the team's (hooks/useDeployTargets); a target
 * the viewer's team does not declare still gets its row, without a queue or a press.
 */
export function prDeployRows(
  reach: DeployReach | null | undefined,
  targets: ReadonlyArray<DeployTargetRow>,
  deploys: ReadonlyArray<TeamDeployRow>,
  repository: string,
  now: number,
): { rows: PrDeployRow[]; dormant: Array<{ target: string; at: number | null }> } {
  if (!reach) return { rows: [], dormant: [] };
  const rows: PrDeployRow[] = [];
  const dormant: Array<{ target: string; at: number | null }> = [];
  for (const t of reach.targets) {
    const row = targets.find((x) => x.name === t.target && sameRepo(x.repository, repository));
    if (isDormant(t, row, deploys, now)) { dormant.push({ target: t.target, at: (t.deploy ?? t.now)?.at ?? null }); continue; }
    const waiting = t.state === "waiting" || t.state === "failed";
    let queue: PrDeployRow["queue"] = null;
    if (row && waiting && row.queue.known) {
      const q = row.queue;
      const listed = q.groups.some((g) => g.commits.some((c) => sameSha(c.sha, reach.sha)));
      // The queue lists its newest commits only: one past that list may still wait, with a count nobody can give. One
      // missing from a queue shown whole is not in it, and the row claims nothing.
      const partial = q.truncated || q.commits > q.shown;
      if (listed) queue = { others: Math.max(0, q.commits - 1), atLeast: q.truncated, ci: q.head_ci, ciUrl: q.head_ci_url };
      else if (partial) queue = { others: null, atLeast: false, ci: q.head_ci, ciUrl: q.head_ci_url };
    }
    const note = t.state === "failed" && t.deploy ? deploys.find((d) => d.short_id === t.deploy!.short_id)?.note ?? null : null;
    rows.push({
      target: t.target,
      state: t.state,
      deploy: t.deploy,
      now: t.now,
      note,
      queue,
      ...(waiting ? pressOf(row, deploys) : { press: null, pressWords: null, blocked: null }),
    });
  }
  rows.sort((a, b) => ATTENTION[a.state] - ATTENTION[b.state] || a.target.localeCompare(b.target));
  return { rows, dormant };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The few words beside a merged pull request's state: where it is live, or what holds it, by target when they are
 * few. `state` is the server's verdict over the whole change (contracts/deployReach), so the chip and every other
 * surface that reads reach agree; the rows only name the targets.
 */
export function prReachHeadline(state: ReachState | null | undefined, rows: ReadonlyArray<PrDeployRow>): { state: ReachState; words: string } | null {
  if (!state) return null;
  const names = rows.filter((r) => r.state === "live").map((r) => r.target);
  if (state === "live") return { state, words: names.length === 0 ? "Live" : names.length <= 2 ? `Live on ${names.join(" and ")}` : `Live on all ${names.length} targets` };
  const these = rows.filter((r) => r.state === state).map((r) => r.target);
  const where = these.length === 1 ? these[0] : null;
  const live = rows.filter((r) => r.state === "live").length;
  const word = state === "queued" ? "deploy queued" : REACH_LOOK[state].word;
  const head = where
    ? state === "going_out" ? `Deploying to ${where}` : `${cap(word)} on ${where}`
    : cap(word);
  return { state, words: live ? `${head} · live on ${live} of ${rows.length}` : head };
}

/**
 * The targets an open pull request goes to once it merges, by the rule reach reads (convex deployReach): a target
 * that names no paths ships everything only where no target names any. A target that has shipped nothing in a week
 * and has nothing going out is idle, and comes last.
 */
export function prShipsTo(
  targets: ReadonlyArray<DeployTargetRow>,
  deploys: ReadonlyArray<TeamDeployRow>,
  repository: string,
  files: ReadonlyArray<string> | null | undefined,
  now: number,
): Array<{ target: DeployTargetRow; idle: boolean }> | null {
  // Files not in hand yet: unknown, not "nothing". The server ships a change of unknown files everywhere.
  if (!files) return null;
  const mine = targets.filter((t) => sameRepo(t.repository, repository) && !t.record_only);
  const someNamePaths = mine.some((t) => t.paths.length > 0);
  return mine
    .filter((t) => !(someNamePaths && t.paths.length === 0) && commitTouchesTarget(t.paths, files))
    .map((target) => ({ target, idle: idleByHistory(target, deploys, now) }))
    .sort((a, b) => Number(a.idle) - Number(b.idle) || a.target.name.localeCompare(b.target.name));
}
