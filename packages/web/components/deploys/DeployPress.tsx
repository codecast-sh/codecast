"use client";
// The review a Deploy, Redeploy or Roll back press opens (hooks/useDeployPress):
// the consequential ledger of what goes out, from what, its CI and how to undo it.
import { pressLedger, type Press } from "../../lib/deploys/press";
import type { TeamDeployRow } from "../../lib/deploys/targets";
import { SwitchReview } from "../consequential/ConsequentialSwitch";

export type { Press };

export function PressReview({ press, deploys, onClose, onConfirm }: { press: Press; deploys: ReadonlyArray<TeamDeployRow>; onClose: () => void; onConfirm: () => void }) {
  return <SwitchReview ledger={pressLedger(press, deploys)} onClose={onClose} onConfirm={onConfirm} />;
}
