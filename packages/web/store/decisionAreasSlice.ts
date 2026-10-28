// Who decides for which areas, and sharing the open decisions out by them
// (convex/decisionAreas.ts, decisionShareOut.ts). Two writes, each painted on
// the click and riding `dispatch` to the side effect of the same name:
//
// - applyDecisionAreas: the map "Change areas" previewed, painted on each
//   member's teamMembers row (focus_project_ids, takes_decisions). A member
//   the map leaves out keeps no areas, as the server applies it.
// - shareOutDecisions: the moves Share out previewed, painted on each
//   decision's row: it is the new owner's alone, held by them. The server
//   applies a move only when the rule still gives it to them; the echo
//   settles any it skipped.
//
// Spread into the org slice (orgSlice createOrgSlice), so the store gains
// both without a line of its own.
import { action } from "./mutativeMiddleware";
import type { AreaAssignment } from "@codecast/shared/contracts/decisionAreas";

export type ShareOutMoveInput = { decision_id: string; to: string };

export type DecisionAreasSliceActions = {
  applyDecisionAreas: (teamId: string, assignments: AreaAssignment[]) => void;
  shareOutDecisions: (teamId: string, moves: ShareOutMoveInput[]) => void;
};

export function createDecisionAreasSlice(): DecisionAreasSliceActions {
  return {
    applyDecisionAreas: action(function (this: any, _teamId: string, assignments: AreaAssignment[]) {
      const given = new Map(assignments.map((a) => [String(a.user_id), a]));
      for (const m of this.teamMembers ?? []) {
        if (m.is_bot) continue;
        const a = given.get(String(m._id));
        m.focus_project_ids = a ? [...a.project_ids] : [];
        if (a) m.takes_decisions = a.takes_decisions;
      }
    }) as DecisionAreasSliceActions["applyDecisionAreas"],

    shareOutDecisions: action(function (this: any, _teamId: string, moves: ShareOutMoveInput[]) {
      const me = String(this.currentUser?._id ?? "");
      const now = Date.now();
      for (const mv of moves) {
        const row = this.sessionDecisions?.[mv.decision_id];
        if (!row || row.status !== "pending") continue;
        row.holder = { kind: "user", id: mv.to };
        row.holder_key = `user:${mv.to}`;
        row.asked_user_ids = [mv.to];
        row.in_queue = mv.to === me;
        row.updated_at = now;
      }
    }) as DecisionAreasSliceActions["shareOutDecisions"],
  };
}
