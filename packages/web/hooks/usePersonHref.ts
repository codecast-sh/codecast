import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { teamMembersOf } from "../lib/activeTeam";

/** A person's page link by their GitHub handle, else their id. */
export function usePersonHref(): (userId: string) => string {
  const members = useInboxStore(teamMembersOf) as Array<{ _id: string; github_username?: string }> | undefined;
  return useCallback((id: string) => `/team/${encodeURIComponent(members?.find((m) => String(m._id) === id)?.github_username || id)}`, [members]);
}
