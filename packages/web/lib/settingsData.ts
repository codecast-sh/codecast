/** Feeds that answer for one team and take `{ team_id }`. */
export const TEAM_SCOPED_SETTINGS = new Set(["teamMembers", "githubInstallations", "team"]);

export function settingsDataKey(name: string, userId?: string | null, teamId?: string | null): string | null {
  if (!userId) return null;
  if (TEAM_SCOPED_SETTINGS.has(name) && !teamId) return null;
  const scope = name === "directoryMappings" || name === "syncProjects" || name === "accountProfiles" || name === "connections" || name === "googleConnections" || name === "agentBoxes" || name === "personalGithubInstallations"
    ? "user"
    : teamId ?? "personal";
  return `${userId}:${scope}:${name}`;
}
