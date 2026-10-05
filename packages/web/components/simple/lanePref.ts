// The lane preference (`client_state.ui.lane`) and the gesture that moves a
// person between lanes, in a module of their own so the full app (its shell,
// settings) can use them without loading the lane.
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useInboxStore } from "../../store/inboxStore";

/** "simple" is the hosted assistant's lane; "full" or absent is the whole app. */
export type Lane = "simple" | "full";

export function laneOf(ui: { lane?: string } | null | undefined): Lane {
  return ui?.lane === "simple" ? "simple" : "full";
}

/** Where each lane opens. */
export const LANE_HOME: Record<Lane, string> = { simple: "/simple", full: "/inbox" };

/** Moves the person between the lane and the full app: the preference is
 *  written first (it follows them to every device), then the view moves. */
export function useSetLane(): (lane: Lane) => void {
  const navigate = useNavigate();
  return useCallback(
    (lane: Lane) => {
      useInboxStore.getState().updateClientUI({ lane });
      navigate(LANE_HOME[lane]);
    },
    [navigate],
  );
}
