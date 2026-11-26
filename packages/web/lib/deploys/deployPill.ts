// A deploy and a change's reach as a reference reads them (deploys.md DP7,
// DP16): the state a dp-N pill wears, the words after its name, the line its
// hover card leads with, and the word a merged pull request or main commit
// carries for how far it has gone toward production. Web and phone draw the
// same words in the same tones. Pure: no store, no React.
import { actionsRunKey, type DeployStatus } from "@codecast/shared/contracts/deploys";
import type { ReachState } from "@codecast/shared/contracts/deployReach";
import { LINE_DEPLOY_STEP_LABELS } from "@codecast/shared/contracts/lineDeploy";

/** A deploy pill's states: its status, with a live deploy split by whether it still runs on its target. */
export type DeployPillState = "waiting" | "going_out" | "live" | "replaced" | "failed" | "cancelled";

/** The palette both apps map to their own colors. */
export type DeployTone = "green" | "yellow" | "red" | "orange" | "muted" | "dim";

type DeployLike = {
  status?: DeployStatus | string | null;
  action?: string | null;
  after?: { open?: boolean } | null;
  replaced_by?: unknown;
  created_at?: number | null;
  live_at?: number | null;
  finished_at?: number | null;
};

export function deployPillState(d: DeployLike): DeployPillState {
  switch (d.status) {
    case "requested": return "waiting";
    case "running": return "going_out";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    // Replaced once a newer deploy went live on the target (`replaced_by`, or `after.open` on a row without it).
    default: return d.replaced_by || d.after?.open === false ? "replaced" : "live";
  }
}

/** A deploy that sends an earlier version out again, the target's rollback. */
export const isRollback = (d: DeployLike) => d.action === "rollback";

/** Asked for, and no machine has started it this long after: a person should look. */
export const STALLED_AFTER_MS = 60 * 60 * 1000;
export const deployStalled = (d: DeployLike, now: number) =>
  d.status === "requested" && d.created_at != null && now - d.created_at > STALLED_AFTER_MS;

/** A deploy's tone at `now`: its state's, except one no machine has picked up for an hour is orange. */
export function deployTone(d: DeployLike, now: number): DeployTone {
  if (deployStalled(d, now)) return "orange";
  const state = deployPillState(d);
  // A rollback that is live (or going out) is the team undoing something: the orange of a rolled-back change, not a calm green.
  if (isRollback(d) && (state === "live" || state === "going_out")) return "orange";
  return DEPLOY_PILL_TONE[state];
}

export const DEPLOY_PILL_TONE: Record<DeployPillState, DeployTone> = {
  waiting: "muted",
  going_out: "yellow",
  live: "green",
  replaced: "muted",
  failed: "red",
  cancelled: "dim",
};

/** How long, as precise as it is worth reading: `<1m`, `12m`, `1h 22m`, past 10h the hours (`20h`), then `3d 2h`. */
export function deployElapsed(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h >= 24) return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
  const m = mins % 60;
  return m && h < 10 ? `${h}h ${m}m` : `${h}h`;
}

/** How long ago, in its largest unit: `just now`, `12m ago`, `5h ago`, `3d ago`. */
export function deployAgo(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return mins < 24 * 60 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / (24 * 60))}d ago`;
}

/**
 * What follows a deploy's name on its pill: how long, while it still waits or goes out; nothing once settled. The
 * glyph and tone carry the state, so the pill names no state in words.
 */
export function deployPillElapsed(d: DeployLike, now: number): string | null {
  const state = deployPillState(d);
  return state === "waiting" || state === "going_out" ? deployElapsed(now - (d.created_at ?? now)) : null;
}

/** A deploy's state in words, for its tooltip and screen readers. A deploy still waiting or deploying carries how long. */
export function deployPillSuffix(d: DeployLike, now: number): string {
  const since = deployElapsed(now - (d.created_at ?? now));
  const back = isRollback(d);
  switch (deployPillState(d)) {
    case "waiting": return `waiting ${since}`;
    case "going_out": return back ? `rolling back ${since}` : `deploying ${since}`;
    case "live": return back ? "rolled back" : "live";
    case "replaced": return "replaced";
    case "failed": return back ? "rollback failed" : "failed";
    case "cancelled": return "cancelled";
  }
}

/**
 * The line a deploy's hover card leads with. `clock` formats a wall time ("3:41 PM"). A replaced deploy's line names
 * what replaced it, a link the card draws itself (replacedLine), so this is its words without one.
 */
export function deployHeadline(d: DeployLike & { sha?: string | null }, now: number, clock: (ts: number) => string): string {
  const created = d.created_at ?? now;
  const to = d.sha ? ` to ${d.sha.slice(0, 7)}` : "";
  switch (deployPillState(d)) {
    case "waiting": return deployStalled(d, now) ? "No machine has started it" : "Waiting to start";
    case "going_out": return isRollback(d) ? `Rolling back${to} for ${deployElapsed(now - created)}` : `Deploying for ${deployElapsed(now - created)}`;
    case "live": return isRollback(d) ? `Rolled back${to}` : `Live since ${clock(d.live_at ?? created)}`;
    case "replaced": return "Replaced by a newer deploy";
    case "failed": {
      const after = d.finished_at ? ` after ${deployElapsed(d.finished_at - created)}` : "";
      return isRollback(d) ? `Rollback failed${after}` : `Failed${after}`;
    }
    case "cancelled": return "Cancelled";
  }
}

/** What replaced a live deploy (deploys.get `replaced_by`): its verb, and the deploy to link with when. */
export function replacedLine(r: { short_id: string; sha?: string | null; at: number; rollback?: boolean }, now: number): { verb: string; label: string; ago: string } {
  return { verb: r.rollback ? "Rolled back by" : "Replaced by", label: r.sha ? r.sha.slice(0, 7) : r.short_id, ago: deployAgo(r.at, now) };
}

/** A deploy step's name, as the Deploys page says it. */
export function deployStepLabel(id: string): string {
  if (id === "gate") return "Eval gate";
  return LINE_DEPLOY_STEP_LABELS[id as keyof typeof LINE_DEPLOY_STEP_LABELS] ?? id;
}

/** The word and tone a change's reach reads as, on its pill, its chip and each target's row. */
export const REACH_LOOK: Record<ReachState, { word: string; tone: DeployTone }> = {
  live: { word: "live", tone: "green" },
  going_out: { word: "deploying", tone: "yellow" },
  queued: { word: "queued", tone: "muted" },
  failed: { word: "deploy failed", tone: "red" },
  rolled_back: { word: "rolled back", tone: "orange" },
  waiting: { word: "not live yet", tone: "dim" },
};

/**
 * When a target's reach began: the deploy that took it live or failed, or (rolled back) the deploy that replaced it.
 * The state word sits beside it, so only a deploy not yet live says what its time means: when it started, or when it
 * was asked for. Null
 * when it waits.
 */
export function reachTime(t: { state: ReachState; deploy: { at: number } | null; now: { at: number } | null }): { verb: string | null; at: number } | null {
  if (t.state === "rolled_back") return t.now ? { verb: null, at: t.now.at } : null;
  if (!t.deploy) return null;
  return { verb: t.state === "going_out" ? "started" : t.state === "queued" ? "queued" : null, at: t.deploy.at };
}

type DeployRowLike = { short_id?: string; url?: string | null; workflow_run?: string | null };

/** The GitHub Actions run a reference names: a run's url (any attempt form), or its bare id (run ids are GitHub-wide). */
export function runRefKey(ref: string): string | null {
  const trimmed = ref.trim();
  return actionsRunKey(trimmed) ?? (/^\d{9,}$/.test(trimmed) ? trimmed : null);
}

/**
 * The deploy a reference names, among rows the store holds: by `dp-N`, or by
 * the GitHub Actions run that carries it.
 */
export function deployMatchesRef(d: DeployRowLike | null | undefined, ref: string): boolean {
  if (!d) return false;
  const run = runRefKey(ref);
  return run ? (d.workflow_run ?? actionsRunKey(d.url)) === run : d.short_id === ref.trim().toLowerCase();
}
