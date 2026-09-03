// The one rule every restart gate applies to a pair of daemon build ids.
//
// The build id is a VETO, never a trigger. Each restart decision keeps its own
// precondition (a newer CLI version, a disk version mismatch, a finished self
// update) and only asks this function whether to cancel. Nothing here can cause
// a restart that would not happen anyway. That direction matters: worktrees of
// this repo run the same CLI at different commits, so an id that could START a
// restart would let a worktree bounce the main daemon into its own tree on
// every edit.
//
// An unknown id never suppresses a restart. A daemon too old to stamp one, an
// unreadable file, an install shape with no id on disk: all of them keep the
// behaviour that existed before the id did.
//
// No imports on purpose: the CLI fast path calls this before it loads anything.

/** True only when both ids are known and equal, which is the sole case a
 *  caller may stand down on. */
export function daemonBuildUnchanged(running: string | null | undefined, candidate: string | null | undefined): boolean {
  return !!running && !!candidate && running === candidate;
}

/** How many hex characters an id carries. The stamp writer and every reader
 *  take it from here, so widening it is one edit. */
export const BUILD_ID_CHARS = 12;

/** The id on its own, as `cast _build-id` prints it. */
export const BUILD_ID_VALUE_RE = new RegExp(`^[0-9a-f]{${BUILD_ID_CHARS}}$`);

/** The stamp line inside the generated daemonBuildId.ts, as the stamp script
 *  and the daemon's read of another install's copy both match it. */
export const BUILD_ID_RE = /DAEMON_BUILD_ID\s*=\s*["']([0-9a-f]+)["']/;
