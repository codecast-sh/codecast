// Integration tests (daemon.inject-clear.test.ts) drive a REAL claude under a
// throwaway project dir, so its transcript lands in ~/.claude/projects like any
// other and would otherwise be synced as a phantom inbox conversation. The dir
// name carries this marker; both loops refuse any path containing it. A single
// lowercase token (no dots or hyphens) so it survives both the exact recorded-cwd
// resolution AND the lossy dir-name slug decode (where every "/" and "." collapses
// to "-"). Enforced on every machine regardless of the user's excluded_paths config.
export const TEST_SCRATCH_DIRNAME = "codecasttestscratch";

// The other two markers the test suites stamp into their throwaway cwds:
// `messagingHarness.ts` (a real tmux pane running the fake claude shim) and
// `fakeClaudeShim.ts`. Both carry hyphens, so they survive the slug ENCODE that
// names the dir under ~/.claude/projects but not the lossy DECODE back to a
// path, where every "-" reads as a "/". isTestArtifactPath normalizes both
// spellings to one before matching, so a marker is recognized whichever form
// of the path a caller happens to hold.
const TEST_PATH_MARKERS = [
  TEST_SCRATCH_DIRNAME,
  "codecast-test-cwd-",
  "codecast-fake-claude-",
];

/**
 * A path produced by codecast's own test suites, in any of its spellings: the
 * recorded cwd, the encoded dir name under ~/.claude/projects, or the decoded
 * dir name. Never user data, so no gate may let one through — a synced one is a
 * phantom conversation in the user's inbox (2026-06-03 for the scratch marker,
 * 2026-09-07 for the harness ones).
 */
export function isTestArtifactPath(candidatePath: string): boolean {
  if (!candidatePath) return false;
  const normalized = candidatePath.replace(/[/.]/g, "-");
  return TEST_PATH_MARKERS.some(marker => normalized.includes(marker));
}
