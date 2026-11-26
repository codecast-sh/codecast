// Who looks at a run's journey (lib/ship/journey.ts JourneyViewer): the viewer,
// and the run's open card, which says who may answer it (canAnswer). The queue
// feed holds the card when the viewer was asked; the detail feed brings it for
// anyone else who can read the run, mounted whenever a gate is open so the
// first paint never guesses. The journey says "You" only when the viewer may answer.
// A session the run waits on that asks a person: the card it asked with (lib/ship/sessionAsk.ts).
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncDecisionDetail } from "./useSyncDecisionDetail";
import { gateOpen, type GateDecision, type JourneyRun, type JourneyViewer } from "../lib/ship/journey";
import { blockedWaitOf, sessionAskOf, type AskRow, type SessionAsk } from "../lib/ship/sessionAsk";
import { memberDisplayName } from "../lib/liveEntities";
import { teamMembersOf } from "../lib/activeTeam";
import { roleRowsOf } from "../lib/roleRows";

/** The fields of a decision row that say who may answer it, as one string, so the subscription wakes only when they change. */
const answerSig = (d: GateDecision | undefined) => (d ? JSON.stringify([d.user_id ?? null, d.holder ?? null, d.passed_to ?? null, d.asked_user_ids ?? null]) : "");

export function useJourneyViewer(run: (Pick<JourneyRun, "status" | "gate_decision_id" | "gate_prompt" | "gate_decision_status" | "waiting_on_session" | "node_statuses">) | null | undefined): JourneyViewer {
  const id = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const decisionId = run && gateOpen(run) ? run.gate_decision_id ?? null : null;
  useSyncDecisionDetail(decisionId ?? undefined);
  const sig = useInboxStore((s) => {
    if (!decisionId) return "";
    return answerSig((s.sessionDecisions as Record<string, GateDecision>)[decisionId] ?? (s as any).decisionDetails?.[decisionId]?.decision);
  });
  // Who answers the card, by name: the chip says whom the run waits on (pl-1075 Words), never only "a person" or
  // "a role": a person by the team's roster, a role by its title (the Release Captain for @release).
  const holderName = useInboxStore((s) => {
    if (!sig) return null;
    const [, holder, passed_to] = JSON.parse(sig);
    const to = passed_to ?? holder;
    if (to?.kind === "role") return roleRowsOf(s as any).roles.find((r) => String(r._id) === String(to.id))?.name ?? null;
    if (to?.kind !== "user") return null;
    const m = teamMembersOf(s).find((x: any) => x && String(x._id) === String(to.id));
    return m ? memberDisplayName(m) : null;
  });
  // The session the run waits on asks a person (it pinned blocked): the card it asked with, read only while it waits.
  // The subscription is the collection's ref (a store write costs a compare); the scan runs only when it changes.
  const wait = blockedWaitOf(run);
  const rows = useInboxStore((s) => (wait ? (s.sessionDecisions as Record<string, AskRow>) : null));
  const askSig = useMemo(() => {
    const ask = wait && rows ? sessionAskOf(Object.values(rows), wait, id) : null;
    return ask ? JSON.stringify(ask) : "";
  }, [rows, wait?.conversation_id, wait?.since, wait?.after, id]);
  return useMemo(() => {
    const ask: SessionAsk | null = askSig ? JSON.parse(askSig) : null;
    if (!sig) return { id, decision: null, ask };
    const [user_id, holder, passed_to, asked_user_ids] = JSON.parse(sig);
    return { id, decision: { user_id, holder, passed_to, asked_user_ids }, holder_name: holderName, ask };
  }, [id, sig, holderName, askSig]);
}
