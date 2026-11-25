"use client";
// Deploy, Redeploy and Roll back from wherever a target can be sent (the Deploys
// page, a session's run card): a press opens PressReview, and the confirm paints
// the requested deploy at once through the store's deployTarget. The Deploys
// page also pauses, lifts and rolls back production (deploys.md DP17, DP19):
// Pause and the paused Roll back open a review that asks why; Lift is one press.
import { useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { productionOf, type DeployProductionRow, type DeployTargetRow, type TeamDeployRow } from "../lib/deploys/targets";
import { sendLift, sendPause, sendPress, sendRollback } from "../lib/deploys/press";
import { PauseReview, PressReview, RollbackReview, type Press, type RollbackPress } from "../components/deploys/DeployPress";

type Open = { kind: "press"; press: Press } | { kind: "pause"; target: DeployTargetRow; targets: ReadonlyArray<DeployTargetRow> } | { kind: "rollback"; press: RollbackPress };

/** `productions` are the team's (useDeployTargets): a press reads its repository's pause there. */
export function useDeployPress(teamId: string | null, deploys: ReadonlyArray<TeamDeployRow>, productions: ReadonlyArray<DeployProductionRow>) {
  const me = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? "You");
  const [opened, setOpened] = useState<Open | null>(null);
  const close = () => setOpened(null);
  const review = !opened ? null
    : opened.kind === "press" ? <PressReview press={opened.press} production={productionOf(productions, opened.press.target)} deploys={deploys} onClose={close} onConfirm={() => { close(); if (teamId) sendPress(opened.press, teamId, deploys, me); }} />
    : opened.kind === "pause" ? <PauseReview target={opened.target} targets={opened.targets} deploys={deploys} onClose={close} onConfirm={(reason) => { close(); sendPause(opened.target, reason, me); }} />
    : <RollbackReview press={opened.press} deploys={deploys} onClose={close} onConfirm={(reason) => { close(); sendRollback(opened.press, reason, deploys, me); }} />;
  return {
    open: (press: Press) => setOpened({ kind: "press", press }),
    /** Pause the target's repository: every one of `targets` on it stops. */
    openPause: (target: DeployTargetRow, targets: ReadonlyArray<DeployTargetRow>) => setOpened({ kind: "pause", target, targets }),
    openRollback: (press: RollbackPress) => setOpened({ kind: "rollback", press }),
    lift: sendLift,
    review,
  };
}
