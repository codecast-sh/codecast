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

/** Per-agent config dirs in $HOME that codecast users routinely open sessions
 *  in. They live outside the conventional project parents (and are dotfiles,
 *  which the scan above skips), so without this whitelist the recent-project
 *  picker would hide them. Deliberately NOT part of enumerateProjectRoots: the
 *  vault registry shares that list, and ~/.claude is not a notes vault. */
export const AGENT_HOME_DIRS = [".claude", ".codex", ".gemini", ".cursor", ".pi", ".opencode"] as const;

/**
 * The agent home dirs that exist on this host, symlinks resolved. Resolving
 * (rather than skipping) symlinks matters because agents record the physical
 * cwd, so a `~/.claude -> ~/dotfiles/claude` link means sessions are filed
 * under the target; reporting the target is what makes them match. Deduped so
 * two links to one dir report once.
 */
export function enumerateAgentHomeDirs(home = process.env.HOME): string[] {
  if (!home) return [];
  const dirs = new Set<string>();
  for (const name of AGENT_HOME_DIRS) {
    try {
      const real = fs.realpathSync(path.join(home, name));
      if (fs.statSync(real).isDirectory()) dirs.add(real);
    } catch {}
  }
  return Array.from(dirs);
}

export async function enumerateLocalRootsAsync(home: string, started: string[] = []): Promise<string[]> {
  const missing = (error: unknown) => ['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
  const roots = new Set<string>();
  for (const parent of PROJECT_PARENT_DIRS) {
    const parentPath = path.join(home, parent);
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(parentPath, { withFileTypes: true }); } catch (error) { if (!missing(error)) throw error; continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(parentPath, entry.name);
      try { if ((await fs.promises.stat(full)).isDirectory()) roots.add(full); } catch (error) { if (!missing(error)) throw error; }
    }
  }
  const combined = new Set([...roots].slice(0, MAX_PROJECT_ROOTS));
  for (const name of AGENT_HOME_DIRS) {
    try { const real = await fs.promises.realpath(path.join(home, name)); if ((await fs.promises.stat(real)).isDirectory()) combined.add(real); } catch (error) { if (!missing(error)) throw error; }
  }
  for (const p of started) {
    try { if ((await fs.promises.stat(p)).isDirectory()) combined.add(p); } catch (error) { if (!missing(error)) throw error; }
  }
  return [...combined].slice(0, MAX_PROJECT_ROOTS);
}
