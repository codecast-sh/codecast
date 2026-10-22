// The team a directory's work belongs to, from its directory mapping (`cast teams map`): the mapping whose path is
// the longest prefix of the directory. A read that names no team defaults to it before the active team, so a
// checkout mapped to one team reads that team's things whichever team is active (flows.md FL2: the pool).
import * as path from "node:path";

export type MappedProject = { path: string; team_id: string | null; private?: boolean };

/** The team id the directory is mapped to, or null when no mapping covers it (or the closest one is locked private). */
export function teamForDirectory(projects: ReadonlyArray<MappedProject>, cwd: string): string | null {
  const dir = path.resolve(cwd);
  const covering = projects
    .filter((p) => p.path && (dir === path.resolve(p.path) || dir.startsWith(path.resolve(p.path) + path.sep)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return covering && !covering.private ? covering.team_id ?? null : null;
}

/** The directory mappings, read the way `cast teams mappings` reads them; none when the server cannot be reached. */
export async function fetchMappedProjects(siteUrl: string, apiToken: string): Promise<MappedProject[]> {
  try {
    const response = await fetch(`${siteUrl}/cli/teams/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken, limit: 30 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { projects?: MappedProject[] };
    return data.projects ?? [];
  } catch {
    return [];
  }
}
