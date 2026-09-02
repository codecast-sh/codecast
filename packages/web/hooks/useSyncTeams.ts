import { useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useSwitchWorkspace } from "./useSwitchWorkspace";
import { useIsSyncHost } from "./useSyncRole";

/**
 * The viewer's teams, into the store.
 *
 * Small, but not optional: `teamHasFeature` reads this collection, so a window
 * that does not feed it has calls, chat and the walkie switched off — silently,
 * because "the team does not have this feature" and "I never learned what this
 * team has" look identical at the gate. The sidebar fed it for the whole app,
 * which held right up until a route rendered without a sidebar.
 *
 * Returns the live query result for callers that want it before the store round
 * trip (the workspace switcher reads the active team from it).
 */
export function useSyncTeams(): any[] | undefined {
  // Follower windows receive `teams` over replication; only a host feeds it.
  const isSyncHost = useIsSyncHost();
  const teamsQuery = useQuery(api.teams.getUserTeams, isSyncHost ? {} : "skip");
  useConvexSync(
    teamsQuery,
    useCallback((d: any) => useInboxStore.getState().syncTable("teams", d), []),
  );

  // A deleted or departed active team leaves the mirror dangling: unstamped
  // ui keys are local wins, so the server's repoint never lands, and every
  // team-scoped query then errors in the raw. When the echo no longer holds
  // the active team, repoint to a surviving one through the sanctioned
  // switch. The timer lets a just-created team's echo catch up first: right
  // after create the real id is active while the list subscription still
  // holds the old answer, and that gap must not read as a deleted team.
  const switchWorkspace = useSwitchWorkspace();
  useEffect(() => {
    if (!Array.isArray(teamsQuery)) return;
    const active = useInboxStore.getState().clientState.ui?.active_team_id;
    // Stub ids (optimistic create) resolve on their own; only a real id can dangle.
    if (!active || !isConvexId(String(active))) return;
    if (teamsQuery.some((t: any) => t?._id?.toString() === String(active))) return;
    const timer = setTimeout(() => {
      const now = useInboxStore.getState().clientState.ui?.active_team_id;
      if (String(now) !== String(active)) return;
      void switchWorkspace((teamsQuery[0]?._id as string | undefined) ?? null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [teamsQuery, switchWorkspace]);

  return teamsQuery as any[] | undefined;
}
