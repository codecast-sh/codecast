// Sync-scope rules shared by the sync loop AND the reconciliation loop. Kept in
// its own leaf module (no daemon/config deps) so both can import the SAME rule
// without a circular import. If these two loops ever disagree about which files
// are in scope, reconciliation "repairs" files the sync loop refuses to sync —
// writing zombie zero-position ledger entries that surface forever as phantom
// "stuck syncs" (file changed, never synced, "last sync 20618 days ago").

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
