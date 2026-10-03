import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

/** The team roster (teams.getTeamMembers) into `teamMembers`. A feeder only:
 *  surfaces read the store, so they paint the cached roster, and a terminal
 *  server error degrades to that cache instead of unmounting anything. On
 *  2026-09-21 a half-saved edit of getTeamMembers reached prod for about a
 *  minute, and every surface reading a plain useQuery stayed broken for hours.
 *  One hook for the web header and the phone's sync bridge. */
export function useSyncTeamMembers(teamId: Id<"teams"> | string | undefined | null): void {
  useSyncCollection(
    "teamMembers",
    api.teams.getTeamMembers,
    // isConvexId: a just-created team holds an optimistic stub id until the
    // server echoes, and a stub is not an Id<"teams">.
    teamId && isConvexId(String(teamId)) ? { team_id: teamId as Id<"teams"> } : "skip",
  );
}
