// Where this machine keeps its code. One enumeration, shared by everything that
// needs to know the user's projects: the daemon publishes it on the heartbeat as
// local_project_roots, and the vault registry turns it into browsable project
// vaults. Two copies of this list would mean the vault picker and the recent
// project picker disagreeing about what projects exist.

import * as fs from "fs";
import * as path from "path";

/** Conventional parents of a project directory. Both cases of "projects" are
 *  listed because macOS is case-insensitive but Linux is not. */
export const PROJECT_PARENT_DIRS = ["src", "dev", "Projects", "projects", "repos", "code"] as const;

/** Upper bound on what we report. High enough to cover a real machine, low
 *  enough that a home directory full of junk degrades instead of hanging. */
export const MAX_PROJECT_ROOTS = 300;

/**
 * First-level children of the conventional project parents that exist on this
 * host. Bounded, and no deeper than one level: the server accepts projects
 * nested below these too, so a monorepo layout like ~/dev/union/union-mobile
 * still resolves — it just isn't enumerated here.
 */
export function enumerateProjectRoots(home = process.env.HOME): string[] {
  if (!home) return [];
  const roots = new Set<string>();
  for (const parent of PROJECT_PARENT_DIRS) {
    const parentPath = path.join(home, parent);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parentPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      // A symlinked project directory is still a project directory, so resolve
      // rather than skip — but confirm it lands on one.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(parentPath, entry.name);
      try {
        if (fs.statSync(full).isDirectory()) roots.add(full);
      } catch {}
    }
  }
  return Array.from(roots).slice(0, MAX_PROJECT_ROOTS);
}
