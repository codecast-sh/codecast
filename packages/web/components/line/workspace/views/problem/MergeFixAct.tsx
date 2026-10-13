"use client";
// The act that lands one fix a run built (line-journeys.md LJ8.3): one primary
// control, through the review every consequential act goes through
// (SwitchReview). Its words say what the press will really do, read from the
// ship plan: "Merge this fix…" where Ship may merge, else "Open its pull
// request…". Pressing it lands nothing; the review states the change, the
// branch, whether it merges and why not, and its confirm names the act. The
// press is Ship (docs/architecture/ship.md) on the fix's pull request when it
// has one (merges once its checks pass), else on the task, which ships the
// build session's branch (convex ship.ts workSessionOfTask). Ship's team
// feature only decides where Ship buttons show; landing a fix never waits on it.
// The line's merge step is a fact beside it, never a control of its own.
import { useMemo, useState } from "react";
import { GitMerge } from "lucide-react";
import { useShipTarget } from "../../../../../hooks/useShipTarget";
import { useInboxStore } from "../../../../../store/inboxStore";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { fixActName, mergeFixLedger, type BranchStanding, type FixChange } from "../../../../../lib/line/mergeFixLedger";

export function MergeFixAct({ taskId, problem, change, approved, primary = true, standing = null }: {
  taskId: string;
  problem: string;
  change: FixChange;
  /** The decision that approved it ("sd-583 · Oct 12"); null when nobody answered, so this press approves it. */
  approved: string | null;
  primary?: boolean;
  /** Where the branch stands against the branch it lands on (useFixBranch), said in the review when it is behind. */
  standing?: BranchStanding | null;
}) {
  // The task's plan names the pull request the fix already has; Ship on that pull request merges it once its checks pass.
  const task = useShipTarget({ kind: "task", id: taskId });
  const prId = task?.pr_id ?? null;
  const onPr = useShipTarget(prId ? { kind: "pull_request", id: prId } : null);
  const target = prId ? { kind: "pull_request" as const, id: prId } : { kind: "task" as const, id: taskId };
  const plan = (prId ? onPr : task)?.plan ?? null;
  const prNumber = plan?.pr.action === "shepherd" ? plan.pr.number : null;
  const merge = useMemo(() => mergeFixLedger({ problem, plan, change, approved, prNumber, standing }), [problem, plan, change, approved, prNumber, standing]);
  const startShip = useInboxStore((s) => s.startShip);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="lw-act" data-primary={primary ? "" : undefined} onClick={() => setOpen(true)} data-line-merge-fix={plan ? (plan.merge.will ? "merge" : "pr") : "reading"}>
        <GitMerge className="w-3.5 h-3.5" aria-hidden />{fixActName(plan)}…
      </button>
      {open && (
        <SwitchReview
          ledger={merge}
          onClose={() => setOpen(false)}
          onConfirm={() => { if (!plan || merge.blocked) return; startShip(target, `ship-${Date.now().toString(36)}`, plan.decisionId ?? undefined); setOpen(false); }}
        />
      )}
    </>
  );
}
