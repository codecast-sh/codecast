import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

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
  const teamsQuery = useQuery(api.teams.getUserTeams);
  useConvexSync(
    teamsQuery,
    useCallback((d: any) => useInboxStore.getState().syncTable("teams", d), []),
  );
  return teamsQuery as any[] | undefined;
}
