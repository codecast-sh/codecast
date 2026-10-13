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
import { SessionPane } from "../../stage/SessionPane";
import { decisionQueueItems } from "../../../lib/decisionQueue";

export function DecisionSession({ id, position = 1, total = 1, onSkip }: { id: string; position?: number; total?: number; onSkip?: () => void }) {
  // The decision's document: where it was asked, and the card's model when no queue row holds it (a trial's
  // practice answer, a decision asked of a teammate): the session's own pending asks lead when the store has them.
  useSyncDecisionDetail(id);
  const decision = useDecisionDetail(id)?.decision;
  const sessions = useInboxStore((s) => s.sessions);
  const conversationId = decision?.conversation_id ?? null;
  const item = useMemo(() => (decision && decision.status === "pending" ? decisionQueueItems({ [decision._id]: decision }, sessions)[0] : undefined), [decision, sessions]);
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
