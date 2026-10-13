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
import { useShipTarget } from "../../../../../hooks/useShipTarget";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { useInboxStore } from "../../../../../store/inboxStore";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { mergeFixLedger, type FixChange } from "../../../../../lib/line/mergeFixLedger";

export function MergeFixAct({ taskId, problem, change, approved, projectId, mergeStep }: { taskId: string; problem: string; change: FixChange; approved: string | null; projectId: string | null; /** The line's merge step, when its role is known. */ mergeStep: boolean | null }) {
  // Ship is a team feature: read for the team the problem lives in, which need not be the active one. Off, the review
  // still opens and says so, so the person sees what stands between the fix and a merge.
  const team = useInboxStore((s) => {
    const ws = projectId ? (s.projects as Record<string, { workspace?: string | null }> | undefined)?.[projectId]?.workspace : null;
    const id = ws?.startsWith("team:") ? ws.slice(5) : null;
    const t = id ? (s.teams || []).find((x: { _id: string }) => x._id === id) as { name?: string } | undefined : undefined;
    return `${workspaceFeatureEnabled(s.teams || [], id, "ship") ? 1 : 0}|${t?.name ?? (id ? "this team" : "Personal")}`;
  });
  const shipOff = team.startsWith("0") ? team.slice(2) : null;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="lw-act" data-primary="" onClick={() => setOpen(true)} data-line-merge-fix>
        <GitMerge className="w-3.5 h-3.5" aria-hidden />Merge this fix…
      </button>
      {open && <MergeFixReview taskId={taskId} problem={problem} change={change} approved={approved} mergeStep={mergeStep} shipOff={shipOff} onClose={() => setOpen(false)} />}
    </>
  );
}

function MergeFixReview({ taskId, problem, change, approved, mergeStep, shipOff, onClose }: { taskId: string; problem: string; change: FixChange; approved: string | null; mergeStep: boolean | null; shipOff: string | null; onClose: () => void }) {
  // The task's plan names the pull request the fix already has; Ship on that pull request merges it once its checks pass.
  const task = useShipTarget({ kind: "task", id: taskId });
  const prId = task?.pr_id ?? null;
  const onPr = useShipTarget(prId ? { kind: "pull_request", id: prId } : null);
  const target = prId ? { kind: "pull_request" as const, id: prId } : { kind: "task" as const, id: taskId };
  const row = prId ? onPr : task;
  const plan = row?.plan ?? null;
  const prNumber = plan?.pr.action === "shepherd" ? plan.pr.number : null;
  const ledger = useMemo(() => mergeFixLedger({ problem, plan, change, approved, prNumber, mergeStep, shipOff }), [problem, plan, change, approved, prNumber, mergeStep, shipOff]);
  const startShip = useInboxStore((s) => s.startShip);
  return (
    <SwitchReview
      ledger={ledger}
      onClose={onClose}
      onConfirm={() => { if (!plan || plan.blocked || shipOff) return; startShip(target, `ship-${Date.now().toString(36)}`, plan.decisionId ?? undefined); onClose(); }}
    />
  );
}
