// The review of landing one approved fix (MergeFixAct, line-journeys.md LJ8.3
// "Approved, not merged"), as plain data: what merges, from where to where,
// whether the line may merge it, and what stands in the way.
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";

export type FixChange = { files: number; added: number; removed: number; pr: string | null } | null;

/** Why Ship cannot start, as the confirm button can say it. */
function blockedWords(plan: ShipPlan | null): string | undefined {
  if (!plan) return "Reading the plan";
  const b = plan.blocked;
  if (!b) return undefined;
  if (/already merged/i.test(b)) return "Already merged";
  if (/is closed/i.test(b)) return "Pull request closed";
  if (/no checkout/i.test(b)) return "No checkout known";
  return "Cannot start";
}

/** The review of landing one approved fix: what merges, from where to where, and whether the line may merge it. */
export function mergeFixLedger(r: { problem: string; plan: ShipPlan | null; change: FixChange; approved: string | null; prNumber: number | null; mergeStep: boolean | null }): SwitchLedger {
  const will = !!r.plan?.merge.will;
  const branch = r.plan?.branch ? `${r.plan.branch} → ${r.plan.base}` : null;
  return {
    name: will ? "Merge this fix" : "Open its pull request",
    subject: r.problem,
    shift: ["Approved", will ? "Merged" : "Pull request"],
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
      ...(r.approved ? [{ k: "Approved", v: r.approved }] : []),
      ...(will ? [{ k: "To undo", v: "Revert PR" }] : []),
    ],
    confirm: will ? "Merge" : "Open pull request",
    keep: "Not now",
    blocked: blockedWords(r.plan),
  };
}


/** The same review of this fix when its team's Ship is off: still named for the fix and its branch, with turning Ship on
 *  for the team (admins only) as the step it needs first, said as what it is: a switch for everyone in the team. The
 *  confirm turns Ship on; the review then redraws as the merge itself. */
export function shipOnLedger(r: { team: string; admin: boolean; merge: SwitchLedger }): SwitchLedger {
  return {
    ...r.merge,
    alert: `Ship is off for ${r.team}`,
    rows: [{ k: "Needs first", v: `Ship on, for all of ${r.team}`, tone: "warn" as const }, ...r.merge.rows],
    stop: "Team settings, Features",
    confirm: "Turn on Ship",
    blocked: r.admin ? r.merge.blocked : `Only ${r.team} admins can turn on Ship`,
  };
}
