import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useSwitchWorkspace } from "./useSwitchWorkspace";
import { useIsSyncHost } from "./useSyncRole";
import { useServerAuthState } from "./useServerAuthSettled";

import { useWatchEffect } from "./useWatchEffect";
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
  // getUserTeams answers an anonymous caller with `[]`, which this collection
  // would read as "no teams": held until the server confirms the caller, and
  // blind while it has lost them (useServerAuthSettled).
  const { settled, identityLost } = useServerAuthState();
  const liveQuery = useQueryNoThrow(api.teams.getUserTeams, isSyncHost && settled ? {} : "skip").data;
  const teamsQuery = identityLost ? undefined : liveQuery;
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
  //
  // The repoint rewrites the canonical pointer every device reads, so it never
  // trusts getUserTeams' `[]`, which a socket the server answers as nobody also
  // gets (a rotated token) while the client still counts itself signed in. A
  // suspected dangle asks getUserTeamsV2, whose answer says when the caller is
  // anonymous, and only a granted view without the team repoints.
  const switchWorkspace = useSwitchWorkspace();
  const active = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // Stub ids (optimistic create) resolve on their own; only a real id can dangle.
  const dangling = Array.isArray(teamsQuery) && !!active && isConvexId(String(active))
    && !teamsQuery.some((t: any) => t?._id?.toString() === String(active));
  const confirmed = useQueryNoThrow(api.teams.getUserTeamsV2, isSyncHost && settled && !identityLost && dangling ? {} : "skip").data as
    | { access: string; teams?: Array<{ _id: string }> }
    | undefined;
  useWatchEffect(() => {
    if (!dangling || confirmed?.access !== "granted" || !Array.isArray(confirmed.teams)) return;
    if (confirmed.teams.some((t) => String(t._id) === String(active))) return;
    const timer = setTimeout(() => {
      const now = useInboxStore.getState().clientState.ui?.active_team_id;
      if (String(now) !== String(active)) return;
      void switchWorkspace((confirmed.teams?.[0]?._id as string | undefined) ?? null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [dangling, confirmed, active, switchWorkspace]);

  return teamsQuery as any[] | undefined;
}
