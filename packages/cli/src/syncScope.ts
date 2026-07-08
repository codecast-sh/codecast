// Sync-scope rules shared by the sync loop, the reconciliation loop, AND
// `cast doctor` (which must place its self-test transcript somewhere the sync
// loop will accept). Kept in its own leaf module (no daemon deps) so all of
// them import the SAME rule without a circular import — and so the CLI bundle
// doesn't pull in the whole daemon. If any two of these ever disagree about
// which files are in scope, reconciliation "repairs" files the sync loop
// refuses to sync — writing zombie zero-position ledger entries that surface
// forever as phantom "stuck syncs" (file changed, never synced, "last sync
// 20618 days ago").

import * as path from "node:path";
import type { Config } from "./config/types.js";

// Integration tests (daemon.inject-clear.test.ts) drive a REAL claude under a
// throwaway project dir, so its transcript lands in ~/.claude/projects like any
// other and would otherwise be synced as a phantom inbox conversation. The dir
// name carries this marker; both loops refuse any path containing it. A single
// lowercase token (no dots or hyphens) so it survives both the exact recorded-cwd
// resolution AND the lossy dir-name slug decode (where every "/" and "." collapses
// to "-"). Enforced on every machine regardless of the user's excluded_paths config.
export const TEST_SCRATCH_DIRNAME = "codecasttestscratch";

export function isTestScratchPath(projectPath: string): boolean {
  return !!projectPath && projectPath.includes(TEST_SCRATCH_DIRNAME);
}

export function isPathExcluded(projectPath: string, excludedPaths?: string): boolean {
  if (!excludedPaths || !projectPath) {
    return false;
  }

  const paths = excludedPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);

  for (const excludedPath of paths) {
    const normalizedExcluded = path.resolve(excludedPath);
    const normalizedProject = path.resolve(projectPath);

    if (normalizedProject.startsWith(normalizedExcluded)) {
      return true;
    }
  }

  return false;
}

export function isProjectAllowedToSync(projectPath: string, config: Config): boolean {
  if (isTestScratchPath(projectPath)) {
    return false;
  }
  if (!config.sync_mode || config.sync_mode === "all") {
    return true;
  }

  if (!config.sync_projects || config.sync_projects.length === 0) {
    return false;
  }

  const normalizedProject = path.resolve(projectPath);
  return config.sync_projects.some(allowed => {
    const normalizedAllowed = path.resolve(allowed);
    return normalizedProject === normalizedAllowed || normalizedProject.startsWith(normalizedAllowed + path.sep);
  });
}
