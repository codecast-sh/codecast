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

/** The conversation a decision (sd-N or its row id) was asked from: the store's row, else its fetched detail. */
function useAskingConversation(ref: string): string | null {
  const held = useInboxStore((s) => {
    const rows = s.sessionDecisions as Record<string, { short_id?: string; conversation_id: string }>;
    const row = rows[ref] ?? Object.values(rows).find((d) => d.short_id === ref);
    return row?.conversation_id ?? null;
  });
  useSyncDecisionDetail(held ? undefined : ref);
  const fetched = useDecisionDetail(held ? undefined : ref)?.decision.conversation_id ?? null;
  return held ?? fetched;
}

export function DecisionSession({ id, position = 1, total = 1, onSkip }: { id: string; position?: number; total?: number; onSkip?: () => void }) {
  const conversationId = useAskingConversation(id);
  const stepper = useMemo<DecisionStepper>(() => ({ position, total, onDone: () => {}, onSkip: onSkip ?? (() => {}) }), [position, total, onSkip]);
  if (!conversationId) return <div className="fy-session" data-line-decision-session={id} />;
  return (
    <DecisionStepperContext.Provider value={stepper}>
      <div className="fy-session h-full" data-line-decision-session={id}>
        <SessionPane key={conversationId} sessionId={conversationId} />
      </div>
    </DecisionStepperContext.Provider>
  );
}
