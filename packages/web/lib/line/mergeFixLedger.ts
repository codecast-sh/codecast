// The review of landing one approved fix (MergeFixAct, line-journeys.md LJ8.3
// "Approved, not merged"), as plain data: what merges, from where to where,
// whether the line may merge it, and what stands in the way.
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";

export type FixChange = { files: number; added: number; removed: number; pr: string | null } | null;

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

/** The review of landing one fix: what merges, from where to where, and whether the line may merge it. `approved`: the
 *  decision that approved it ("sd-583 · Oct 12"); null when nobody answered, and then this press is the approval. */
export function mergeFixLedger(r: { problem: string; plan: ShipPlan | null; change: FixChange; approved: string | null; prNumber: number | null; mergeStep: boolean | null }): SwitchLedger {
  const will = !!r.plan?.merge.will;
  const branch = r.plan?.branch ? `${r.plan.branch} → ${r.plan.base}` : null;
  return {
    name: fixActName(r.plan),
    subject: r.problem,
    shift: [r.approved ? "Approved" : "Unanswered", will ? "Merged" : "Pull request"],
    alert: !r.plan || will ? undefined : r.mergeStep === false ? "Merge step off" : "Will not merge",
    figures: r.change && r.change.files > 0 ? [
      { value: String(r.change.files), label: r.change.files === 1 ? "file" : "files" },
      { value: `+${r.change.added}`, label: "added" },
      { value: `−${r.change.removed}`, label: "removed" },
    ] : [],
    rows: [
      ...(branch ? [{ k: "Branch", v: branch }] : []),
      { k: "Pull request", v: r.prNumber != null ? `#${r.prNumber}` : r.change?.pr ? "Open" : "Opens one" },
      ...(r.plan?.checks.length ? [{ k: "Checks", v: "Run first" }] : []),
      { k: "Merges", v: will ? "When checks pass" : "No", tone: will ? "warn" as const : undefined },
      ...(r.mergeStep === false ? [{ k: "Merge step", v: "Off", tone: "warn" as const }] : []),
      { k: "Approved", v: r.approved ?? "By this press", tone: r.approved ? undefined : "warn" as const },
      ...(will ? [{ k: "To undo", v: "Revert PR" }] : []),
    ],
    confirm: will ? "Merge" : r.plan?.pr.action === "shepherd" ? "Ship pull request" : "Open pull request",
    keep: "Not now",
    blocked: blockedWords(r.plan),
  };
}
