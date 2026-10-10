import { useCallback } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { useIsSyncHost } from "./useSyncRole";
import { useSyncCollection } from "./useSyncCollection";
import { settingsDataKey, TEAM_SCOPED_SETTINGS } from "../lib/settingsData";

const queries = {
  directoryMappings: api.users.getDirectoryTeamMappings,
  syncProjects: api.users.getRecentProjectsWithGitInfo,
  accountProfiles: api.accountSwitch.listAccountProfiles,
  connections: api.appConnections.listConnections,
  // The person's Google connections with what each grant allows (the simple
  // lane's connections screen). Read on demand, not in the global set.
  googleConnections: api.googleOAuth.listConnections,
  // The person's mail and calendar connection through Whisk (the simple
  // lane's connections, home and /welcome). Read on demand, not in the global set.
  whiskConnection: api.whisk.connection,
  teamMembers: api.teams.getTeamMembers,
  // The active team's own record (name, invite code) for the team settings row.
  team: api.teams.getTeam,
  githubInstallations: api.githubApp.listInstallations,
  // The same query with no team named answers with the caller's own installs.
  personalGithubInstallations: api.githubApp.listInstallations,
  agentBoxes: api.devices.listAgentBoxes,
  // The team's monthly model budget (learning-loop.md LL10), for its settings section. Read on demand.
  teamBudget: api.modelCalls.budgetForTeam,
};

export type SettingsDataName = keyof typeof queries;

// The settings the sync host feeds for every window (useSyncSettings), for the
// active team. Replication carries them to followers, so a follower reading
// one of these for the active team leaves the query to the host. Anything
// else (an on-demand name, another team's copy) is a per-view read and
// subscribes in whichever window asks for it.
const HOST_FED: readonly SettingsDataName[] = [
  "directoryMappings",
  "syncProjects",
  "accountProfiles",
  "connections",
  "teamMembers",
  "githubInstallations",
  "personalGithubInstallations",
  "agentBoxes",
];
const HOST_FED_SET = new Set<SettingsDataName>(HOST_FED);

function useSettingsFeed(name: SettingsDataName, requestedTeamId?: string | null) {
  const userId = useInboxStore((s) => s.currentUser?._id);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamId = requestedTeamId === undefined ? activeTeamId : requestedTeamId;
  const isHost = useIsSyncHost();
  const key = settingsDataKey(name, userId, teamId);
  const teamQuery = TEAM_SCOPED_SETTINGS.has(name);
  const hostFeedsIt = HOST_FED_SET.has(name) && requestedTeamId === undefined;
  const args = !key || (!isHost && hostFeedsIt) || (teamQuery && !isConvexId(String(teamId)))
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
  // A module constant, so the hook order never changes between renders.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  for (const name of HOST_FED) useSettingsFeed(name);
}
