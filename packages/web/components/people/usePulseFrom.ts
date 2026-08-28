// The team pulse, derived from roster data the caller already holds.
//
// Its own module so TeamPulseLine.tsx stays a Fast Refresh boundary — the same
// split as usePeopleWall and useFaceKey next door.
import { useMemo } from "react";
import { teamPulse, type TeamPulse } from "./teamPulse";
import { type PeopleRosterData } from "./usePeopleRoster";

/** The pulse from roster data the caller already holds — never a second
 *  subscription. The panel reads the roster once and derives this from it. */
export function usePulseFrom({ members, fleets, huddles }: PeopleRosterData): TeamPulse {
  return useMemo(
    () => teamPulse(members, (m: any) => fleets.get(String(m._id)), huddles),
    [members, fleets, huddles],
  );
}
