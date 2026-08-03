export type RecentProjectPath = {
  path: string;
  count: number;
  lastActive: number;
  suggested?: boolean;
};

type ProjectSession = {
  user_id?: string;
  project_path?: string;
  git_root?: string;
  updated_at?: number;
};

// Stable primitive for Zustand selectors. Minute-bucketing retains meaningful
// recent ordering without making the always-mounted picker re-render on each
// per-second working-session heartbeat.
export function recentProjectSessionKey(session: ProjectSession): string {
  return JSON.stringify([
    session.user_id ?? "",
    session.project_path || session.git_root || "",
    Math.floor((session.updated_at ?? 0) / 60_000),
  ]);
}

export function recentProjectPathsFromSessionKeys(
  keys: string[],
  currentUserId: string | null | undefined,
): RecentProjectPath[] {
  return recentProjectPathsFromSessions(keys.map((key) => {
    const [user_id, project_path, updatedMinute] = JSON.parse(key) as [string, string, number];
    return { user_id, project_path, updated_at: updatedMinute * 60_000 };
  }), currentUserId);
}

function usableRecentPath(raw: string): string | null {
  const path = raw
    .replace(/\/+$/, "")
    .replace(/\/\.conductor\/[^/]+$/, "")
    .replace(/\/\.codecast\/worktrees\/[^/]+$/, "");
  if (!path || /^\/(tmp|var|private\/tmp|private\/var)(\/|$)/.test(path)) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0 || (parts[0] === "root" && parts.length === 1)) return null;
  if ((parts[0] === "Users" || parts[0] === "home") && parts.length <= 2) return null;
  return path;
}

/**
 * Recover recent paths from the user's already-loaded session cache. This is a
 * deliberate fallback for startup / stale-daemon windows where the server's
 * device-root-filtered query is empty even though the inbox already contains
 * authoritative sessions the user ran in those folders.
 */
export function recentProjectPathsFromSessions(
  sessions: ProjectSession[],
  currentUserId: string | null | undefined,
): RecentProjectPath[] {
  if (!currentUserId) return [];
  const byPath = new Map<string, RecentProjectPath>();
  for (const session of sessions) {
    if (session.user_id !== currentUserId) continue;
    const rawPath = session.project_path || session.git_root;
    const path = rawPath ? usableRecentPath(rawPath) : null;
    if (!path) continue;
    const updated = session.updated_at ?? 0;
    const existing = byPath.get(path);
    if (existing) {
      existing.count += 1;
      existing.lastActive = Math.max(existing.lastActive, updated);
    } else {
      byPath.set(path, { path, count: 1, lastActive: updated });
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastActive - a.lastActive);
}

/** Keep the server's ranked order, then fill any gaps from loaded own sessions. */
export function mergeRecentProjectPaths(
  server: RecentProjectPath[],
  local: RecentProjectPath[],
): RecentProjectPath[] {
  const seen = new Set(server.map((project) => project.path));
  return server.concat(local.filter((project) => !seen.has(project.path)));
}

/**
 * The resting chip row next to the current project: the few folders the user
 * actually uses most, capped tight. Machine-root suggestions (count 0, never
 * used through codecast) never appear here — they live behind the full picker.
 */
export function frequentProjectChips<T extends { path: string; count: number; suggested?: boolean }>(
  projects: T[],
  max = 4,
): T[] {
  return projects
    .filter((p) => !p.suggested)
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

/**
 * Browse order for the full picker: folders with real usage first, then the
 * machine-root suggestions as one trailing block (the UI draws its divider at
 * the first `suggested` entry).
 */
export function browseProjectOrder<T extends { path: string; suggested?: boolean }>(
  projects: T[],
): T[] {
  return [...projects.filter((p) => !p.suggested), ...projects.filter((p) => p.suggested)];
}
