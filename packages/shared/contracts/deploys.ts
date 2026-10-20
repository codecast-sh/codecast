// Deploys as objects (docs/architecture/deploys.md). A deploy is one version
// going live on one target (a surface like "backend", an environment like
// "production"): what went out, who or what started it, when, and what
// happened after. The line's deploy stage sends the shipped fixes waiting to
// go out together in one deploy; a deploy the team's own path records (a
// `cast ship mark`, a source's deploy item) is the same object. Pure types and
// rules here; the server, the CLI and the web all read them.
import { carryingDeploys, deployIsLive, type AttemptMerge, type DeployRow } from "./causeHistory";

/** Short ids of deploys: `dp-N`, minted by counters.nextShortId. */
export const DEPLOY_SHORT_ID_PREFIX = "dp";
export const DEPLOY_SHORT_ID_RE = /^dp-\d+$/i;

/**
 * requested: the line asked for it and no machine has started it yet.
 * running:   the team's deploy path is running it.
 * live:      a marker says the version runs on the target.
 * failed / cancelled: it ended without going live.
 */
export const DEPLOY_STATUSES = ["requested", "running", "live", "failed", "cancelled"] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

/**
 * What started it. `person`: someone pressed Deploy (the Line page, `cast
 * line deploy`). `role`, `schedule`, `count`: the line's own triggers
 * (`[line.deploy] trigger`). `outside`: the team's own deploy path, recorded
 * when its marker arrived (a deploy button elsewhere, a CI job, a laptop).
 */
export const DEPLOY_TRIGGERS = ["person", "role", "schedule", "count", "outside"] as const;
export type DeployTrigger = (typeof DEPLOY_TRIGGERS)[number];

// The `[line.deploy]` profile section lives in its own leaf, so a reader of
// the profile (the daemon) need not load the deploy history behind this file.
export { LINE_DEPLOY_DEFAULTS, LINE_DEPLOY_KEYS, LINE_DEPLOY_TRIGGERS, normalizeDeployTarget, type LineDeployProfile, type LineDeployTrigger } from "./lineDeploy";

/**
 * How a deploy is known to carry a fix. `sent`: the line's deploy stage sent
 * it, the fix was waiting when the deploy was asked for. `same commit` and
 * `deployed after the merge`: the rule a recorded deploy is read by
 * (causeHistory carryingDeploys).
 */
export type DeployCarriedHow = "sent" | "same commit" | "deployed after the merge";

/** One fix a deploy carried: the problem, the run that built it, the card that shipped it, the merge. */
export type DeployCarry = {
  task_id: string;
  run_id?: string;
  decision_id?: string;
  merge_sha?: string;
  merged_at?: number;
  pr_url?: string;
  how: DeployCarriedHow;
};

export type DeployCommit = { sha: string; subject: string; author?: string };

export type DeployStartedBy = { kind: "person" | "role" | "line" | "source" | "cli"; name: string; user_id?: string; role_id?: string };

/** A merge the waiting set and the carry rule read: a line run's recorded merge. */
export type DeployMerge = {
  run_id: string;
  task_id: string;
  decision_id?: string;
  project_id?: string;
  sha: string;
  branch: string;
  into: string;
  at: number;
  pr_url?: string;
};

const asAttempt = (m: DeployMerge): AttemptMerge => ({
  sha: m.sha, branch: m.branch, into: m.into, at: m.at, prUrl: m.pr_url ?? null, repository: null,
});

/** The merges no live deploy has carried yet: what the deploy stage would send. Oldest first. */
export function waitingMerges(merges: ReadonlyArray<DeployMerge>, deploys: ReadonlyArray<DeployRow>): DeployMerge[] {
  return merges
    .filter((m) => carryingDeploys(asAttempt(m), deploys, m.run_id).length === 0)
    .sort((a, b) => a.at - b.at);
}

/**
 * The merges a recorded deploy carried, by the history's own rule: the deploy
 * is the first live one on its target at or after the merge, on the same code.
 * `deploys` holds every deploy of the project (this one included).
 */
export function carriedBy(deploy: DeployRow, merges: ReadonlyArray<DeployMerge>, deploys: ReadonlyArray<DeployRow>): DeployCarry[] {
  if (!deployIsLive(deploy)) return [];
  const out: DeployCarry[] = [];
  for (const m of [...merges].sort((a, b) => a.at - b.at)) {
    const hit = carryingDeploys(asAttempt(m), deploys, m.run_id).find((d) => d.id === deploy._id);
    if (!hit) continue;
    out.push({
      task_id: m.task_id, run_id: m.run_id, ...(m.decision_id ? { decision_id: m.decision_id } : {}),
      merge_sha: m.sha, merged_at: m.at, ...(m.pr_url ? { pr_url: m.pr_url } : {}), how: hit.how,
    });
  }
  return out;
}

/** What one carried problem did after the deploy: its findings in the window, and whether one reopened it. */
export type DeployAfterProblem = { task_id: string; findings: number; reopened: boolean; first_at: number | null };

/** An error group the window saw start or come back. */
export type DeployAfterError = { group_id: string; short_id: string; title: string; kind: "new" | "regressed"; at: number; count: number };

/**
 * What happened after a deploy, over its window: from going live to the next
 * live deploy on the same target, else to now. `quiet` when nothing it
 * carried came back and no error started.
 */
export type DeployAfter = {
  from: number;
  to: number;
  /** The window is still open (no later deploy on the target). */
  open: boolean;
  problems: DeployAfterProblem[];
  errors: DeployAfterError[];
  regressions: number;
  reopened: number;
  new_errors: number;
  quiet: boolean;
};

export function summarizeAfter(from: number, to: number, open: boolean, problems: DeployAfterProblem[], errors: DeployAfterError[]): DeployAfter {
  const regressions = problems.filter((p) => p.findings > 0).length;
  const reopened = problems.filter((p) => p.reopened).length;
  const newErrors = errors.filter((e) => e.kind === "new").length;
  return { from, to, open, problems, errors, regressions, reopened, new_errors: newErrors, quiet: regressions === 0 && errors.length === 0 };
}

/** A deploy as every reader gets it (deploys.list, deploys.get). */
export type DeployView = {
  _id: string;
  short_id: string;
  /** The store's stub key of a deploy asked for from the web. */
  client_key?: string;
  project_id: string | null;
  target: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  started_by: DeployStartedBy | null;
  source: string;
  repository: string | null;
  sha: string | null;
  previous_sha: string | null;
  version: string | null;
  url: string | null;
  commits: DeployCommit[];
  carries: Array<DeployCarry & { task_short_id: string | null; task_title: string | null; decision_short_id: string | null }>;
  note: string | null;
  created_at: number;
  live_at: number | null;
  finished_at: number | null;
};

/** When a deploy counts on a chart: when it went live, else when it was asked for. */
export const deployAt = (d: Pick<DeployView, "live_at" | "created_at">) => d.live_at ?? d.created_at;

/** A deploy's short label on a chart flag: its target, and the sha when known. */
export function deployFlagLabel(d: Pick<DeployView, "target" | "sha" | "version">): string {
  const v = d.sha ? d.sha.slice(0, 7) : d.version ? d.version.slice(0, 12) : null;
  return v ? `${d.target} ${v}` : d.target;
}

/** One line for a deploy's state, the words every surface uses. */
export function deployStateWords(d: Pick<DeployView, "status" | "carries">, after?: Pick<DeployAfter, "regressions" | "new_errors" | "quiet" | "open"> | null): string {
  if (d.status === "requested") return "waiting for its machine";
  if (d.status === "running") return "going out";
  if (d.status === "failed") return "failed";
  if (d.status === "cancelled") return "cancelled";
  if (!after) return "live";
  if (after.regressions) return `${after.regressions} came back`;
  if (after.new_errors) return `${after.new_errors} new error${after.new_errors === 1 ? "" : "s"}`;
  return after.open ? "live, quiet so far" : "quiet";
}
