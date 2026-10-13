// The review of landing one approved fix (MergeFixAct, line-journeys.md LJ8.3
// "Approved, not merged"), as plain data: what merges, from where to where,
// whether the line may merge it, and what stands in the way.
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";

export type FixChange = { files: number; added: number; removed: number; pr: string | null } | null;

/** Where a fix branch stands against the branch it lands on (convex lineFixChecks.fixBranch), in the words its row and
 *  review say: "97 commits ahead · 12 of its files changed there too". `conflicts`: the base moved some of the branch's
 *  own files, so landing it needs a rebase that can conflict. */
export type BranchStanding = { base: string; behind: number; onBoth: number; conflicts: boolean; words: string };

export function branchStanding(b: { base: string | null; behind: number; on_both: ReadonlyArray<string> } | null): BranchStanding | null {
  if (!b?.base) return null;
  const onBoth = b.on_both.length;
  const words = b.behind === 0 ? `Level with ${b.base}`
    : `${b.behind} ${b.behind === 1 ? "commit" : "commits"} ahead of it${onBoth ? ` · ${onBoth} of its ${onBoth === 1 ? "file" : "files"} changed there too` : ""}`;
  return { base: b.base, behind: b.behind, onBoth, conflicts: b.behind > 0 && onBoth > 0, words };
}

/** Why Ship cannot start, as the confirm button can say it. A fix lives on the branch its run built it on: a plan that
 *  would gather changes off the base branch has found no fix to land (ct-57509 once read a chat on main as the fix). */
function blockedWords(plan: ShipPlan | null): string | undefined {
  if (!plan) return "Reading the plan";
  const b = plan.blocked;
  if (!b) return plan.newBranch ? "No fix branch found" : undefined;
  if (/already merged/i.test(b)) return "Already merged";
  if (/is closed/i.test(b)) return "Pull request closed";
  if (/no checkout/i.test(b)) return "No checkout known";
  return "Cannot start";
}

/** What one press lands, as its button and its review name it: a merge when Ship may merge, else the pull request it
 *  opens (or the one it shepherds). "Ship this fix" until the plan is read. */
export function fixActName(plan: ShipPlan | null): string {
  if (!plan) return "Ship this fix";
  if (plan.merge.will) return "Merge this fix";
  return plan.pr.action === "shepherd" ? "Ship its pull request" : "Open its pull request";
}

/** The review of landing one fix: what merges, from where to where, and who merges it. The press is named for what it
 *  does (fixActName), so a press that only opens a pull request raises no alarm: the merge is a person's, on that pull
 *  request, and the review says so. `approved`: the decision that approved it ("sd-583 · Oct 12"); null when nobody
 *  answered, and then this press is the approval. */
export function mergeFixLedger(r: { problem: string; plan: ShipPlan | null; change: FixChange; approved: string | null; prNumber: number | null; standing?: BranchStanding | null }): SwitchLedger {
  const will = !!r.plan?.merge.will;
  const branch = r.plan?.branch ? `${r.plan.branch} → ${r.plan.base}` : null;
  const st = r.standing ?? null;
  return {
    name: fixActName(r.plan),
    subject: r.problem,
    // Opening a pull request approves nothing: the merge, and so the approval, is a person's on it. Only a press that
    // merges is the approval when nobody answered.
    shift: will ? [r.approved ? "Approved" : "Unanswered", "Merged"] : ["Branch", "Pull request"],
    figures: r.change && r.change.files > 0 ? [
      { value: String(r.change.files), label: r.change.files === 1 ? "file" : "files" },
      { value: `+${r.change.added}`, label: "added" },
      { value: `−${r.change.removed}`, label: "removed" },
    ] : [],
    rows: [
      ...(branch ? [{ k: "Branch", v: branch }] : []),
      { k: "Pull request", v: r.prNumber != null ? `#${r.prNumber}` : r.change?.pr ? "Open" : "Opens one" },
      ...(st && st.behind > 0 ? [{ k: st.base, v: st.words, tone: "warn" as const }] : []),
      ...(r.plan?.checks.length ? [{ k: "Checks", v: "Run first" }] : []),
      { k: "Merges", v: will ? "When checks pass" : "A person, on the pull request", tone: will ? "warn" as const : undefined },
      ...(will ? [{ k: "Approved", v: r.approved ?? "By this press", tone: r.approved ? undefined : "warn" as const }] : r.approved ? [{ k: "Approved", v: r.approved }] : []),
      ...(will ? [{ k: "To undo", v: "Revert PR" }] : []),
    ],
    confirm: will ? "Merge" : r.plan?.pr.action === "shepherd" ? "Ship pull request" : "Open pull request",
    keep: "Not now",
    blocked: blockedWords(r.plan),
  };
}
