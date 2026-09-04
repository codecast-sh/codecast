export function settingsDataKey(name: string, userId?: string | null, teamId?: string | null): string | null {
  if (!userId) return null;
  if ((name === "teamMembers" || name === "githubInstallations") && !teamId) return null;
  const scope = name === "directoryMappings" || name === "syncProjects" || name === "accountProfiles" || name === "connections" || name === "agentBoxes"
    ? "user"
    : teamId ?? "personal";
  return `${userId}:${scope}:${name}`;
}
