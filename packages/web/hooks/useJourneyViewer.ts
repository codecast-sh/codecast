// Who looks at a run's journey (lib/ship/journey.ts JourneyViewer): the viewer,
// and the run's open card, which says who may answer it (canAnswer). The queue
// feed holds the card when the viewer was asked; the detail feed brings it for
// anyone else who can read the run, mounted whenever a gate is open so the
// first paint never guesses. The journey says "You" only when the viewer may answer.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncDecisionDetail } from "./useSyncDecisionDetail";
import { gateOpen, type GateDecision, type JourneyRun, type JourneyViewer } from "../lib/ship/journey";
import { memberDisplayName } from "../lib/liveEntities";
import { teamMembersOf } from "../lib/activeTeam";
import { roleRowsOf } from "../lib/roleRows";

/** The fields of a decision row that say who may answer it, as one string, so the subscription wakes only when they change. */
const answerSig = (d: GateDecision | undefined) => (d ? JSON.stringify([d.user_id ?? null, d.holder ?? null, d.passed_to ?? null, d.asked_user_ids ?? null, d.category ?? null]) : "");

export function useJourneyViewer(run: (Pick<JourneyRun, "status" | "gate_decision_id" | "gate_prompt" | "gate_decision_status" | "team_id">) | null | undefined): JourneyViewer {
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
  // Whether the viewer administers the run's team: an admin who does not hold the card may nudge its holder or answer it.
  const teamId = run?.team_id ? String(run.team_id) : null;
  const admin = useInboxStore((s) => !!sig && !!teamId && ((s.teams || []) as Array<{ _id: string; role?: string }>).some((t) => String(t._id) === teamId && (t.role === "admin" || t.role === "owner")));
  return useMemo(() => {
    if (!sig) return { id, decision: null };
    const [user_id, holder, passed_to, asked_user_ids, category] = JSON.parse(sig);
    return { id, decision: { user_id, holder, passed_to, asked_user_ids, category }, holder_name: holderName, admin };
  }, [id, sig, holderName, admin]);
}
