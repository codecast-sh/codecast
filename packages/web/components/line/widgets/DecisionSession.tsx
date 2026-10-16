"use client";
// A line decision as the session that asked it: the real conversation pane
// with its decision card open (the /questions queue's way: SessionPane plus a
// DecisionStepperContext, so the card opens as the full sheet whatever its
// tier). The session is the decision's home; reading, asking it and answering
// all happen there.
import { useMemo } from "react";
import { DecisionStepperContext, type DecisionStepper } from "../../../hooks/useDecisionQueue";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../hooks/useSyncDecisionDetail";
import { useInboxStore } from "../../../store/inboxStore";
import { agentStatusAt } from "../../../lib/liveness";
import { SessionPane } from "../../stage/SessionPane";
import { decisionQueueItems } from "../../../lib/decisionQueue";

export function DecisionSession({ id, position = 1, total = 1, onSkip }: { id: string; position?: number; total?: number; onSkip?: () => void }) {
  // The decision's document: where it was asked, and the card's model when no queue row holds it (a trial's
  // practice answer, a decision asked of a teammate): the session's own pending asks lead when the store has them.
  useSyncDecisionDetail(id);
  const decision = useDecisionDetail(id)?.decision;
  const conversationId = decision?.conversation_id ?? null;
  // Only what the card reads of the asking session (its title, project, whether it runs), never the whole row.
  const sessionSig = useInboxStore((s) => {
    const r = conversationId ? s.sessions[conversationId] : undefined;
    return r ? `${r.title}|${r.project_path}|${r.is_idle}|${agentStatusAt(r, Date.now())}|${r.is_unresponsive}` : "";
  });
  const item = useMemo(() => {
    if (!decision || decision.status !== "pending") return undefined;
    const sessions = useInboxStore.getState().sessions;
    return decisionQueueItems({ [decision._id]: decision }, sessions)[0];
  }, [decision, sessionSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const stepper = useMemo<DecisionStepper>(() => ({ position, total, onDone: () => {}, onSkip: onSkip ?? (() => {}), item }), [position, total, onSkip, item]);
  if (!conversationId) return <div className="fy-session" data-line-decision-session={id} />;
  return (
    <DecisionStepperContext.Provider value={stepper}>
      <div className="fy-session h-full" data-line-decision-session={id}>
        <SessionPane key={conversationId} sessionId={conversationId} />
      </div>
    </DecisionStepperContext.Provider>
  );
}
