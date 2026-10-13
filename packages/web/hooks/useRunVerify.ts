import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { runVerifyFigure, type VerifyFigure } from "../lib/line/runVerify";

/** A trial card's run's own Verify figure, from the store's run row (lib/line/runVerify). */
export function useRunVerify(runId: string | null | undefined): VerifyFigure | null {
  const sig = useInboxStore((s) => {
    const r = runId ? (s as unknown as { workflowRuns?: Record<string, { node_statuses?: Array<{ node_id: string; result_preview?: string }> }> }).workflowRuns?.[runId] : null;
    return JSON.stringify(runVerifyFigure(r?.node_statuses));
  });
  return useMemo(() => JSON.parse(sig) as VerifyFigure | null, [sig]);
}
