// The web gesture that moves a person between the lane and the full app: the
// preference is written first (lanePref.writeLane), then the view moves.
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { LANE_HOME, writeLane, type Lane } from "./lanePref";

export function useSetLane(): (lane: Lane) => void {
  const navigate = useNavigate();
  return useCallback(
    (lane: Lane) => {
      writeLane(lane);
      navigate(LANE_HOME[lane]);
    },
    [navigate],
  );
}
