// The reviews of a pull request's merge, auto-merge and branch update (PRActions), as data
// (ConsequentialSwitch SwitchLedger).
import type { SwitchLedger } from "./ConsequentialSwitch";

/** A pull request merged into its base branch: one act, undone only by a revert.
 *  `bypass` is a merge past the branch's protection, under the person's own
 *  GitHub account: what it skips and whose name it goes out under lead the review. */
export function prMergeLedger(r: { title: string; number: number; base: string; head?: string; headSha?: string; method: string; deleteBranch: boolean; files?: number; additions?: number; deletions?: number; checks?: string; blockedBy?: string; bypass?: { skips: string; as: string } }): SwitchLedger {
  const alert = r.bypass ? "Bypasses branch protection"
    : r.checks === "failure" ? "Checks failing" : r.blockedBy ? `GitHub: ${r.blockedBy}` : r.checks === "pending" ? "Checks still running" : undefined;
  return {
    name: r.bypass ? `Bypass and merge #${r.number}` : `Merge #${r.number}`,
    subject: r.title,
    shift: ["Open", "Merged"],
    alert,
    figures: [
      ...(r.files != null ? [{ value: String(r.files), label: r.files === 1 ? "file" : "files" }] : []),
      ...(r.additions != null ? [{ value: `+${r.additions}`, label: `−${r.deletions ?? 0} lines` }] : []),
      { value: r.base, label: "lands on", tone: "warn" as const },
    ],
    rows: [
      ...(r.bypass ? [{ k: "Skips", v: r.bypass.skips, tone: "warn" as const }, { k: "As", v: r.bypass.as }] : []),
      { k: "Method", v: r.method },
      ...(r.checks === "success" ? [{ k: "Checks", v: "Passing", tone: "ok" as const }] : []),
      ...headRow(r.headSha),
      { k: "Branch", v: r.deleteBranch ? "Deleted after" : "Kept" },
      { k: "Then", v: `Deploys from ${r.base}` },
      { k: "To undo", v: "Revert PR" },
    ],
    confirm: r.bypass ? "Bypass and merge" : alert ? "Merge anyway" : `Merge into ${r.base}`,
    keep: "Not now",
  };
}

/** The head the press is pinned to: GitHub refuses if the branch moves first. */
function headRow(sha?: string): { k: string; v: string }[] {
  return sha ? [{ k: "Head", v: `${sha.slice(0, 7)}, refused if it moves` }] : [];
}

/** GitHub merges the pull request on its own once required checks and reviews pass. */
export function prAutoMergeLedger(r: { title: string; number: number; base: string; headSha?: string; method: string; checks?: string }): SwitchLedger {
  return {
    name: `Auto-merge #${r.number}`,
    subject: r.title,
    shift: ["Manual", "Auto-merge"],
    figures: [{ value: r.base, label: "lands on", tone: "warn" }],
    rows: [
      { k: "Merges when", v: "Required checks and reviews pass" },
      { k: "Method", v: r.method },
      ...(r.checks ? [{ k: "Checks now", v: r.checks, tone: r.checks === "failure" ? ("warn" as const) : undefined }] : []),
      ...headRow(r.headSha),
    ],
    stop: "Turn it off",
    confirm: "Turn on auto-merge",
    keep: "Not now",
  };
}

/** The base branch merged into the pull request's branch, as a new commit on it. */
export function prUpdateBranchLedger(r: { title: string; number: number; base: string; head?: string; headSha?: string; behindBy?: number }): SwitchLedger {
  return {
    name: `Update #${r.number}`,
    subject: r.title,
    shift: null,
    figures: [
      ...(r.behindBy != null ? [{ value: String(r.behindBy), label: r.behindBy === 1 ? "commit behind" : "commits behind" }] : []),
      { value: r.head ?? "branch", label: "gets a merge commit", tone: "warn" as const },
    ],
    rows: [
      { k: "From", v: r.base },
      ...headRow(r.headSha),
      { k: "Then", v: "Checks run again" },
      { k: "Agents on it", v: "Must pull before pushing" },
    ],
    confirm: `Merge ${r.base} into it`,
    keep: "Not now",
  };
}
