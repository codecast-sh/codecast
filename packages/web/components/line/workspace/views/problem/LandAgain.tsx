"use client";
// Rebase and land: the act an approved fix takes when its landing step refused it for being behind the default
// branch. The problem's band and For you's "Approved, not merged" reader both offer it.
import { useState } from "react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { SwitchReview, type SwitchLedger } from "../../../../consequential/ConsequentialSwitch";

/** Land an approved fix its landing step refused for being behind: the run picks up at Rebase, through the review. */
export function LandAgain({ runId, ledger }: { runId: string; ledger: SwitchLedger }) {
  const [reviewing, setReviewing] = useState(false);
  const run = useInboxStore((s) => (s as unknown as { workflowRuns?: Record<string, { status?: string; current_node_id?: string }> }).workflowRuns?.[runId]);
  if (run?.status === "running" && run.current_node_id === "rebase") return <span className="lw-oc" data-tone="live" data-line-band-landing>Rebasing</span>;
  return (
    <>
      <button type="button" className="lw-act" data-primary="" aria-haspopup="dialog" onClick={() => setReviewing(true)} data-line-band-land>Rebase and land…</button>
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); void useInboxStore.getState().landLineRun(runId); }} />}
    </>
  );
}
