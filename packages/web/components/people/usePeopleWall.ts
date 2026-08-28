// The wall's layout memo, in a module of its own.
//
// Not in PeopleWall.tsx, where it used to live: a .tsx module that exports a
// hook alongside its components is not a Fast Refresh boundary, so editing the
// wall remounted every surface that reads this. Same split as useFaceKey and
// usePeopleRoster next door.
import { useMemo } from "react";
import { memberPresenceVisual } from "../presence/memberPresence";
import { WALL_FACE_PX, buildWall, type Wall, type WallTier } from "./peopleWallLayout";
import type { PeopleRosterData } from "./usePeopleRoster";

/** The wall, laid out from roster data — one memo shared by the wall and the
 *  strip so the two can never sort or size a team differently. */
export function useWall(data: PeopleRosterData, sizes: Record<WallTier, number> = WALL_FACE_PX): Wall<any> {
  const { members, fleets } = data;
  return useMemo(
    () =>
      buildWall(
        members,
        (m: any) => memberPresenceVisual(m),
        (m: any) => fleets.get(String(m._id)) ?? null,
        (m: any) => String(m._id ?? ""),
        (m: any) => m?.name || m?.email || "",
        sizes,
      ),
    [members, fleets, sizes],
  );
}
