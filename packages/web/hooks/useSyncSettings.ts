import { useCallback } from "react";
import { useConvexAuth } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { useIsSyncHost } from "./useSyncRole";
import { useSyncCollection } from "./useSyncCollection";
import { settingsDataKey } from "../lib/settingsData";

const queries = {
  directoryMappings: api.users.getDirectoryTeamMappings,
  syncProjects: api.users.getRecentProjectsWithGitInfo,
  accountProfiles: api.accountSwitch.listAccountProfiles,
  connections: api.appConnections.listConnections,
  teamMembers: api.teams.getTeamMembers,
  githubInstallations: api.githubApp.listInstallations,
  agentBoxes: api.devices.listAgentBoxes,
};

export type SettingsDataName = keyof typeof queries;

function useSettingsFeed(name: SettingsDataName, requestedTeamId?: string | null) {
  const userId = useInboxStore((s) => s.currentUser?._id);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamId = requestedTeamId === undefined ? activeTeamId : requestedTeamId;
  const isHost = useIsSyncHost();
  const { isAuthenticated } = useConvexAuth();
  const key = settingsDataKey(name, userId, teamId);
  const teamQuery = name === "teamMembers" || name === "githubInstallations";
  const args = !key || !isHost || !isAuthenticated || (teamQuery && !isConvexId(String(teamId)))
    ? "skip"
    : teamQuery ? { team_id: teamId }
      : name === "syncProjects" ? { limit: 100 } : {};
  const select = useCallback((value: unknown) => [{ _id: key, value }], [key]);
  const result = useSyncCollection("settingsData", queries[name], args as any, { select });
  return { key, error: result.error };
}

export function useSettingsData<Name extends SettingsDataName>(name: Name, teamId?: string | null) {
  const { key, error } = useSettingsFeed(name, teamId);
  const data = useInboxStore((s) => key ? s.settingsData[key]?.value : undefined) as
    | FunctionReturnType<(typeof queries)[Name]>
    | undefined;
  return { data, error };
}

export function useSyncSettings() {
  useSettingsFeed("directoryMappings");
  useSettingsFeed("syncProjects");
  useSettingsFeed("accountProfiles");
  useSettingsFeed("connections");
  useSettingsFeed("teamMembers");
  useSettingsFeed("githubInstallations");
  useSettingsFeed("agentBoxes");
}
