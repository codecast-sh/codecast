"use client";
// The act of a problem whose fix was approved and never merged (line-journeys.md
// LJ8.3, the `approved` band): one primary control that lands the fix, through
// the one review every consequential act goes through (SwitchReview). Pressing
// it never lands anything; the review says what will happen in facts (the
// change, the branch, whether it merges and why not) and its confirm names the
// act. The press is Ship (docs/architecture/ship.md) on the fix's pull request
// when it has one, which merges once its checks pass, else on the task, which
// opens one and merges only when the line may. The line's merge step is a fact
// beside it, never a control of its own and never a terminal command.
import { useMemo, useState } from "react";
import { GitMerge } from "lucide-react";
import { useShipTarget } from "../../../../../hooks/useShipTarget";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { useInboxStore } from "../../../../../store/inboxStore";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { mergeFixLedger, shipOnLedger, type FixChange } from "../../../../../lib/line/mergeFixLedger";

export function MergeFixAct({ taskId, problem, change, approved, projectId, mergeStep }: { taskId: string; problem: string; change: FixChange; approved: string | null; projectId: string | null; /** The line's merge step, when its role is known. */ mergeStep: boolean | null }) {
  // Ship is a team feature: read for the team the problem lives in, which need not be the active one. Off, the review
  // still opens and says so, so the person sees what stands between the fix and a merge.
  const team = useInboxStore((s) => {
    const ws = projectId ? (s.projects as Record<string, { workspace?: string | null }> | undefined)?.[projectId]?.workspace : null;
    const id = ws?.startsWith("team:") ? ws.slice(5) : null;
    const t = id ? (s.teams || []).find((x: { _id: string }) => x._id === id) as { name?: string; role?: string } | undefined : undefined;
    return `${workspaceFeatureEnabled(s.teams || [], id, "ship") ? 1 : 0}|${t?.role === "admin" ? 1 : 0}|${id ?? ""}|${t?.name ?? (id ? "this team" : "Personal")}`;
  });
  const [on, admin, teamId, ...name] = team.split("|");
  // Ship off: the step the merge is missing. The review turns it on first (admins only), then goes on to the merge.
  const shipOff = on === "0" ? { team: name.join("|"), teamId: teamId || null, admin: admin === "1" } : null;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="lw-act" data-primary="" onClick={() => setOpen(true)} data-line-merge-fix>
        <GitMerge className="w-3.5 h-3.5" aria-hidden />{mergeStep === false ? "Open its pull request…" : "Merge this fix…"}
      </button>
      {open && <MergeFixReview taskId={taskId} problem={problem} change={change} approved={approved} mergeStep={mergeStep} shipOff={shipOff} onClose={() => setOpen(false)} />}
    </>
  );
}

function MergeFixReview({ taskId, problem, change, approved, mergeStep, shipOff, onClose }: { taskId: string; problem: string; change: FixChange; approved: string | null; mergeStep: boolean | null; shipOff: { team: string; teamId: string | null; admin: boolean } | null; onClose: () => void }) {
  // The task's plan names the pull request the fix already has; Ship on that pull request merges it once its checks pass.
  const task = useShipTarget({ kind: "task", id: taskId });
  const prId = task?.pr_id ?? null;
  const onPr = useShipTarget(prId ? { kind: "pull_request", id: prId } : null);
  const target = prId ? { kind: "pull_request" as const, id: prId } : { kind: "task" as const, id: taskId };
  const row = prId ? onPr : task;
  const plan = row?.plan ?? null;
  const prNumber = plan?.pr.action === "shepherd" ? plan.pr.number : null;
  const merge = useMemo(() => mergeFixLedger({ problem, plan, change, approved, prNumber, mergeStep }), [problem, plan, change, approved, prNumber, mergeStep]);
  const startShip = useInboxStore((s) => s.startShip);
  if (shipOff) {
    const ledger = shipOnLedger({ team: shipOff.team, admin: shipOff.admin && !!shipOff.teamId, merge });
    // Turning Ship on paints at once (setTeamFeature is local-first), and this same dialog redraws as the merge review.
    return <SwitchReview ledger={ledger} onClose={onClose} onConfirm={() => { if (shipOff.admin && shipOff.teamId) useInboxStore.getState().setTeamFeature(shipOff.teamId, "ship", true); }} />;
  }
  return (
    <SwitchReview
      ledger={merge}
      onClose={onClose}
      onConfirm={() => { if (!plan || plan.blocked) return; startShip(target, `ship-${Date.now().toString(36)}`, plan.decisionId ?? undefined); onClose(); }}
    />
  );
}
