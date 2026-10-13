"use client";
// The act of a problem whose fix was approved and never merged (line-journeys.md
// LJ8.3, the `approved` band): one primary control that lands the fix, through
// the one review every consequential act goes through (SwitchReview). Pressing
// it never lands anything; the review says what will happen in facts (the
// change, the branch, whether it merges and why not) and its confirm names the
// act. The press is Ship (docs/architecture/ship.md) on the fix's pull request
// when it has one, which merges once its checks pass, else on the task, which
// opens one and merges only when the line may. The line's merge step is a fact
// beside it with the way to its switch, never a terminal command.
import { useMemo, useState } from "react";
import { GitMerge } from "lucide-react";
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import { useShipTarget } from "../../../../../hooks/useShipTarget";
import { workspaceFeatureEnabled } from "../../../../../lib/teamFeatures";
import { useInboxStore } from "../../../../../store/inboxStore";
import { SwitchReview, type SwitchLedger } from "../../../../consequential/ConsequentialSwitch";

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
      ...(r.approved ? [{ k: "Approved", v: r.approved }] : []),
      ...(will ? [{ k: "To undo", v: "Revert PR" }] : []),
    ],
    confirm: will ? "Merge" : "Open pull request",
    keep: "Not now",
    blocked: blockedWords(r.plan),
  };
}

export function MergeFixAct({ taskId, problem, change, approved, projectId, mergeStep }: { taskId: string; problem: string; change: FixChange; approved: string | null; projectId: string | null; /** The line's merge step, when its role is known. */ mergeStep: boolean | null }) {
  // Ship is a team feature: read for the team the problem lives in, which need not be the active one.
  const teamId = useInboxStore((s) => {
    const ws = projectId ? (s.projects as Record<string, { workspace?: string | null }> | undefined)?.[projectId]?.workspace : null;
    return ws?.startsWith("team:") ? ws.slice(5) : null;
  });
  const shipOn = useInboxStore((s) => !!teamId && workspaceFeatureEnabled(s.teams || [], teamId, "ship"));
  const [open, setOpen] = useState(false);
  if (!shipOn) return null;
  return (
    <>
      <button type="button" className="lw-act" data-primary="" onClick={() => setOpen(true)} data-line-merge-fix>
        <GitMerge className="w-3.5 h-3.5" aria-hidden />Merge this fix…
      </button>
      {open && <MergeFixReview taskId={taskId} problem={problem} change={change} approved={approved} mergeStep={mergeStep} onClose={() => setOpen(false)} />}
    </>
  );
}

function MergeFixReview({ taskId, problem, change, approved, mergeStep, onClose }: { taskId: string; problem: string; change: FixChange; approved: string | null; mergeStep: boolean | null; onClose: () => void }) {
  // The task's plan names the pull request the fix already has; Ship on that pull request merges it once its checks pass.
  const task = useShipTarget({ kind: "task", id: taskId });
  const prId = task?.pr_id ?? null;
  const onPr = useShipTarget(prId ? { kind: "pull_request", id: prId } : null);
  const target = prId ? { kind: "pull_request" as const, id: prId } : { kind: "task" as const, id: taskId };
  const row = prId ? onPr : task;
  const plan = row?.plan ?? null;
  const prNumber = plan?.pr.action === "shepherd" ? plan.pr.number : null;
  const ledger = useMemo(() => mergeFixLedger({ problem, plan, change, approved, prNumber, mergeStep }), [problem, plan, change, approved, prNumber, mergeStep]);
  const startShip = useInboxStore((s) => s.startShip);
  return (
    <SwitchReview
      ledger={ledger}
      onClose={onClose}
      onConfirm={() => { if (!plan || plan.blocked) return; startShip(target, `ship-${Date.now().toString(36)}`, plan.decisionId ?? undefined); onClose(); }}
    />
  );
}
