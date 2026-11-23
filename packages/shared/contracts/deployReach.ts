// How far a change has gone toward production (docs/architecture/deploys.md DP16): for each deploy target its commit
// touches, whether the target runs it now, a deploy is taking it out, one holding it is asked for and no machine has
// started it, the last try failed, it was live and was rolled back, or it waits. A deploy holds the change by the rule a problem's history reads (causeHistory holdsMerge): the
// same commit, else a cut on main at or after the change's place, else (no place on main) live at or after the merge.

export type ReachState = "live" | "going_out" | "queued" | "failed" | "rolled_back" | "waiting";

/** A deploy as reach reads it. `cut_at` is its sha's place on main: stamped when it went live, looked up while open. */
export type ReachDeploy = {
  short_id: string;
  status: "requested" | "running" | "live" | "failed" | "cancelled";
  sha?: string | null;
  cut_at?: number | null;
  created_at: number;
  live_at?: number | null;
  finished_at?: number | null;
  url?: string | null;
  note?: string | null;
};

export type ReachDeployRef = { short_id: string; status: ReachDeploy["status"]; sha: string | null; at: number; url: string | null };

export type TargetReach = {
  target: string;
  state: ReachState;
  /** live / rolled_back: the deploy that took it out; going_out / queued: the deploy taking it; failed: the deploy that failed. */
  deploy: ReachDeployRef | null;
  /** rolled_back: the live deploy that does not hold it. */
  now: ReachDeployRef | null;
  /** Shipped nothing in a week and nothing going out: it keeps its row but does not speak for the change's state. */
  dormant?: true;
};

export type DeployReach = {
  /** The whole change: live everywhere it goes, else the state that most needs a reader's eye. */
  state: ReachState;
  sha: string | null;
  targets: TargetReach[];
};

/** What a change is: its commit on main (when known), that commit's place there, and when it merged. */
export type ReachChange = { sha: string | null; main_at: number | null; merged_at: number | null };

const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

/** Whether a deploy's code holds the change. */
export function deployHolds(d: ReachDeploy, c: ReachChange): boolean {
  if (sameSha(d.sha, c.sha)) return true;
  if (d.cut_at != null) {
    const place = c.main_at ?? c.merged_at;
    return place != null && place <= d.cut_at;
  }
  // No place on main: a live deploy holds what merged before it went live; an open one says nothing yet.
  return d.status === "live" && c.merged_at != null && (d.live_at ?? d.created_at) >= c.merged_at;
}

const refOf = (d: ReachDeploy): ReachDeployRef => ({
  short_id: d.short_id,
  status: d.status,
  sha: d.sha ?? null,
  at: d.live_at ?? d.finished_at ?? d.created_at,
  url: d.url ?? null,
});

/** One target's reach, from its deploys (any order). */
export function targetReach(target: string, deploys: ReadonlyArray<ReachDeploy>, c: ReachChange): TargetReach {
  const newest = [...deploys].sort((a, b) => b.created_at - a.created_at);
  const current = newest.find((d) => d.status === "live") ?? null;
  const live = newest.filter((d) => d.status === "live");
  if (current && deployHolds(current, c)) {
    // The first live deploy that held it took it out; the live ones since kept it.
    let first = current;
    for (const d of live) {
      if (!deployHolds(d, c)) break;
      first = d;
    }
    return { target, state: "live", deploy: refOf(first), now: null };
  }
  const open = newest.find((d) => (d.status === "running" || d.status === "requested") && deployHolds(d, c));
  if (open) return { target, state: open.status === "running" ? "going_out" : "queued", deploy: refOf(open), now: current ? refOf(current) : null };
  const wasLive = live.find((d) => d !== current && deployHolds(d, c));
  if (wasLive && current) return { target, state: "rolled_back", deploy: refOf(wasLive), now: refOf(current) };
  // A deploy that tried to take it out after the live one, and failed.
  const since = current ? newest.filter((d) => d.created_at > current.created_at) : newest;
  const failed = since.find((d) => d.status === "failed" && deployHolds({ ...d, status: "live" }, c));
  if (failed) return { target, state: "failed", deploy: refOf(failed), now: current ? refOf(current) : null };
  return { target, state: "waiting", deploy: null, now: current ? refOf(current) : null };
}

const ATTENTION: Record<ReachState, number> = { failed: 0, rolled_back: 1, waiting: 2, queued: 3, going_out: 4, live: 5 };

/** A target that has shipped nothing for this long, and has nothing going out, no longer speaks for a change's state. */
export const DORMANT_TARGET_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a target is dormant: no deploy open and none in a week (Union's aivery-operator, a backend copy shipped rarely). */
function dormant(deploys: ReadonlyArray<ReachDeploy>, now: number): boolean {
  if (deploys.some((d) => d.status === "running" || d.status === "requested")) return false;
  const last = Math.max(0, ...deploys.map((d) => d.live_at ?? d.finished_at ?? d.created_at));
  return now - last > DORMANT_TARGET_MS;
}

/**
 * The change's reach over the targets it touches; null when it touches none. Its state is the one that most needs a
 * reader's eye over the targets still shipping; a dormant target keeps its own row but would otherwise hold every
 * change at "not live yet". When every target is dormant, all of them speak.
 */
export function deployReach(c: ReachChange, targets: ReadonlyArray<{ target: string; deploys: ReadonlyArray<ReachDeploy> }>, now: number): DeployReach | null {
  if (!targets.length) return null;
  const each = targets.map((t) => (dormant(t.deploys, now) ? { ...targetReach(t.target, t.deploys, c), dormant: true as const } : targetReach(t.target, t.deploys, c)));
  const active = each.filter((t) => !t.dormant);
  const state = (active.length ? active : each).reduce<ReachState>((worst, t) => (ATTENTION[t.state] < ATTENTION[worst] ? t.state : worst), "live");
  return { state, sha: c.sha, targets: each };
}
