"use client";
// The review a Deploy, Redeploy or Roll back press opens (hooks/useDeployPress):
// the consequential ledger of what goes out, from what, its CI and how to undo it.
// Pausing production and codecast's own rollback (deploys.md DP17, DP19) ask for
// a reason inside the same review, and confirm only once one is written.
import { useState } from "react";
import { pauseLedger, pressLedger, rollbackLedger, type Press, type RollbackPress } from "../../lib/deploys/press";
import type { DeployTargetRow, TeamDeployRow } from "../../lib/deploys/targets";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";

export type { Press, RollbackPress };

export function PressReview({ press, deploys, onClose, onConfirm }: { press: Press; deploys: ReadonlyArray<TeamDeployRow>; onClose: () => void; onConfirm: () => void }) {
  return <SwitchReview ledger={pressLedger(press, deploys)} onClose={onClose} onConfirm={onConfirm} />;
}

/** A review whose act needs a reason: the reason field sits above its facts, and the confirm waits for it. */
function ReasonReview({ ledger, onClose, onConfirm }: { ledger: (reason: string) => SwitchLedger; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <SwitchReview ledger={ledger(reason)} onClose={onClose} onConfirm={() => onConfirm(reason)}>
      <label className="flex items-center gap-3 border-b border-sol-border/60 px-5 py-2.5 text-[12.5px]" data-deploy-reason>
        <span className="w-[6rem] shrink-0 truncate text-sol-text-dim">Why</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What is wrong in production"
          maxLength={500}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md border border-sol-border bg-sol-bg px-2.5 text-sol-text placeholder:text-sol-text-dim/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50"
          data-deploy-reason-input
        />
      </label>
    </SwitchReview>
  );
}

export function PauseReview({ target, targets, deploys, onClose, onConfirm }: { target: DeployTargetRow; targets: ReadonlyArray<DeployTargetRow>; deploys: ReadonlyArray<TeamDeployRow>; onClose: () => void; onConfirm: (reason: string) => void }) {
  return <ReasonReview ledger={(reason) => pauseLedger(target, targets, deploys, reason)} onClose={onClose} onConfirm={onConfirm} />;
}

export function RollbackReview({ press, deploys, onClose, onConfirm }: { press: RollbackPress; deploys: ReadonlyArray<TeamDeployRow>; onClose: () => void; onConfirm: (reason: string) => void }) {
  return <ReasonReview ledger={(reason) => rollbackLedger(press, deploys, reason)} onClose={onClose} onConfirm={onConfirm} />;
}
