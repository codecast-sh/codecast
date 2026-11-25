// Pausing production and rolling it back (docs/architecture/deploys.md DP17): the rules every reader shares, the
// server, the CLI and the Deploys page.

/** A role's authority grant to pause, lift and roll back production (org-hire.md H4): the Release Captain holds it. */
export const PAUSE_AUTHORITY_ID = "production-pause";
export const PAUSE_AUTHORITY_KIND = "write";
export const PAUSE_AUTHORITY_LABEL = "Pause, lift and roll back production; separate from any deploy grant";

/** Who holds the pause: team admins and members an admin granted it, and a role holding PAUSE_AUTHORITY_ID. */
export const PAUSE_HOLDERS = "founders, engineers and the Release Captain";

/** A file a database migration lives in: a revert of it cannot take the schema back. */
const MIGRATION_PATH_RE = /(^|\/)(migrations?|drizzle)\//i;

export function migrationFilesOf(files: readonly string[]): string[] {
  return files.filter((f) => MIGRATION_PATH_RE.test(f));
}

/**
 * What ends a rollback: a revert of each commit it took off production, or a fix forward when one of them carries a
 * migration (reverting the code leaves the schema where the migration put it).
 */
export function rollbackEnding(commits: ReadonlyArray<{ files?: readonly string[] | null }>): { kind: "revert" | "fix_forward"; migrations: string[] } {
  const migrations = [...new Set(commits.flatMap((c) => migrationFilesOf(c.files ?? [])))];
  return { kind: migrations.length ? "fix_forward" : "revert", migrations };
}

/** A run job that rolls out: once one has started, a cancel no longer stops the deploy cleanly. */
const ROLLOUT_JOB_RE = /^(deploy|rollout)(\s|$)/i;

/** Whether a deploy run has reached rollout, from its jobs (GitHub's jobs API). */
export function reachedRollout(jobs: ReadonlyArray<{ name: string; status: string; conclusion?: string | null }>): boolean {
  return jobs.some((j) => ROLLOUT_JOB_RE.test(j.name) && j.status !== "queued" && j.status !== "waiting" && j.status !== "pending" && j.conclusion !== "skipped");
}

/** How often a standing pause reminds whoever lifts it, inside working hours. */
export const PAUSE_REMIND_MS = 4 * 60 * 60_000;

/** Weekdays 9:00 to 18:00 in the team's zone: the only time a pause reminds anyone. */
export function inWorkingHours(now: number, zone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(now));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
  return !["Sat", "Sun"].includes(weekday) && hour >= 9 && hour < 18;
}

/** A standing pause as the CLI, deploy.sh and the Deploys page read it. */
export type DeployPauseView = {
  repository: string;
  by: string;
  reason: string;
  at: number;
  /** Who lifts it: the commit it waits for, else the person who paused or the Release Captain. */
  lifts: string;
  rollback: string | null;
  until: null | { task: string | null; kind: "revert" | "fix_forward"; migrations: string[]; commits: number };
};

/** One line for a standing pause, as the CLI prints it. */
export function pauseLine(p: DeployPauseView): string {
  return `${p.repository}: production paused by ${p.by}: ${p.reason}. ${p.lifts}`;
}
