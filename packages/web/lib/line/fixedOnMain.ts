// A problem parked because main already carries its fix (lineInbox fixedOnMain):
// what a person checks before closing it. The run's note without the commit it
// names, the repository that commit lives in, whether a recorded deploy carried
// it, and how the commit's CI went. Pure, so a test reads it.
import type { RepoCheck } from "../../hooks/useRepoBrowse";

/** The park note past its "Already fixed on main by <sha>", which the facts say: no leading colon or bracket left. */
export function fixedNoteRest(note: string | null | undefined): string {
  return (note ?? "")
    .replace(/^\s*(?:already )?fixed on main (?:by|in|at) [0-9a-f]+\s*/i, "")
    .replace(/^\(([^)]*)\)/, "$1")
    .replace(/^[\s:;,.\-–—]+/, "")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** The one repository whose name is a directory on the project's path ("…/union-mobile/outreach" → Union-AI/union-mobile); null when none or several are. */
export function repoOnPath(path: string | null | undefined, repositories: ReadonlyArray<string>): string | null {
  const dirs = new Set((path ?? "").toLowerCase().split("/").filter(Boolean));
  const hits = [...new Set(repositories.filter((r) => dirs.has((r.split("/").pop() ?? "").toLowerCase())))];
  return hits.length === 1 ? hits[0] : null;
}

/** Short and full shas name the same commit when one starts with the other (7 characters at least). */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

export type DeployFact = { at: number; sha: string | null; url: string | null };

/** The recorded deploy of the fix commit itself, the earliest; null when none names it. */
export function deployOfCommit(sha: string, deploys: ReadonlyArray<DeployFact>): DeployFact | null {
  return deploys.filter((d) => sameCommit(d.sha, sha)).sort((a, b) => a.at - b.at)[0] ?? null;
}

/** The newest recorded deploy with a commit, the one a later deploy check compares against. */
export function newestDeploy(deploys: ReadonlyArray<DeployFact>): DeployFact | null {
  return deploys.filter((d) => d.sha).sort((a, b) => b.at - a.at)[0] ?? null;
}

export type CiState = { state: "passed" | "failed" | "running" | "none"; failed: string[]; running: string[]; url: string | null };

const BAD = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/** How a commit's CI stands from its check runs: any red is failed, else anything unfinished is running, else passed. */
export function ciState(checks: ReadonlyArray<RepoCheck> | null | undefined): CiState {
  const rows = checks ?? [];
  const failed = rows.filter((c) => c.status === "completed" && BAD.has(c.conclusion ?? "")).map((c) => c.name);
  const running = rows.filter((c) => c.status !== "completed").map((c) => c.name);
  const lead = rows.find((c) => failed.includes(c.name)) ?? rows.find((c) => running.includes(c.name)) ?? rows[0];
  return { state: !rows.length ? "none" : failed.length ? "failed" : running.length ? "running" : "passed", failed, running, url: lead?.url ?? null };
}
