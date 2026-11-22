/** Feeds that answer for one team and take `{ team_id }`. */
/** Settings feeds that no longer exist. Their rows still on disk are dropped at
 *  boot (cacheRetention), since nothing feeds them again. The team roster lives
 *  only in the store's teamMembers (lib/activeTeam teamMembersOf). */
export const RETIRED_SETTINGS = new Set(["teamMembers"]);

export function isRetiredSettingsKey(id: string): boolean {
  return RETIRED_SETTINGS.has(id.slice(id.lastIndexOf(":") + 1));
}

export const TEAM_SCOPED_SETTINGS = new Set(["githubInstallations", "team", "teamBudget", "managedDevices", "teamReadKeys"]);

export function settingsDataKey(name: string, userId?: string | null, teamId?: string | null): string | null {
  if (!userId) return null;
  if (TEAM_SCOPED_SETTINGS.has(name) && !teamId) return null;
  const scope = name === "directoryMappings" || name === "syncProjects" || name === "accountProfiles" || name === "connections" || name === "googleConnections" || name === "whiskConnection" || name === "agentBoxes" || name === "personalGithubInstallations" || name === "agentOAuth"
    ? "user"
    : teamId ?? "personal";
  return `${userId}:${scope}:${name}`;
}
