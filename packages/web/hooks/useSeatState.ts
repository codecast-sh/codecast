import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { SeatState } from "@codecast/convex/convex/teamBilling";
import { useQueryNoThrow } from "./useQueryNoThrow";

export type EnforcedSeatState = Extract<SeatState, { enforced: true }>;

/** The team's seat plan when seat billing is on here, else null. */
export function useSeatState(teamId: Id<"teams">): EnforcedSeatState | null {
  const state = useQueryNoThrow(api.teamBilling.getSeatState, { team_id: teamId }).data;
  return state?.enforced ? state : null;
}
