// Who looks at a run's journey (lib/ship/journey.ts JourneyViewer): the viewer,
// and the run's open card, which says who may answer it (canAnswer). The queue
// feed holds the card when the viewer was asked; the detail feed brings it for
// anyone else who can read the run, mounted whenever a gate is open so the
// first paint never guesses. The journey says "You" only when the viewer may answer.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncDecisionDetail } from "./useSyncDecisionDetail";
import { gateOpen, type GateDecision, type JourneyRun, type JourneyViewer } from "../lib/ship/journey";

/** The fields of a decision row that say who may answer it, as one string, so the subscription wakes only when they change. */
const answerSig = (d: GateDecision | undefined) => (d ? JSON.stringify([d.user_id ?? null, d.holder ?? null, d.passed_to ?? null, d.asked_user_ids ?? null]) : "");

export function useJourneyViewer(run: (Pick<JourneyRun, "status" | "gate_decision_id" | "gate_prompt" | "gate_decision_status">) | null | undefined): JourneyViewer {
  const id = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const decisionId = run && gateOpen(run) ? run.gate_decision_id ?? null : null;
  useSyncDecisionDetail(decisionId ?? undefined);
  const sig = useInboxStore((s) => {
    if (!decisionId) return "";
    return answerSig((s.sessionDecisions as Record<string, GateDecision>)[decisionId] ?? (s as any).decisionDetails?.[decisionId]?.decision);
  });
  return useMemo(() => {
    if (!sig) return { id, decision: null };
    const [user_id, holder, passed_to, asked_user_ids] = JSON.parse(sig);
    return { id, decision: { user_id, holder, passed_to, asked_user_ids } };
  }, [id, sig]);
}
