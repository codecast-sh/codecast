// A daemon running from a source checkout restarts onto the source when it
// changes. Bun loads the module graph once, so without this a daemon runs the
// code it booted with until something else restarts it (a version bump, a
// crash); on 2026-10-05 the laptop's daemon ran a day-old graph through a
// whole round of daemon fixes.
//
// The id is the daemon build id (daemonBuildIdCompute.ts): a hash of every
// source file the daemon imports, so edits elsewhere in the tree never count.
// A change must hold still across two checks before it is taken: the tree is
// shared by many sessions and a half-written edit is not a build. Restarts
// are spaced out, because each one re-adopts every live session.

export const SOURCE_SETTLE_MS = 4 * 60_000;
export const SOURCE_RESTART_SPACING_MS = 30 * 60_000;

export type SourceRestartState = {
  /** The source the running daemon booted on. */
  bootId: string;
  /** A changed id first seen at `pendingSince`, waiting to hold still. */
  pendingId?: string;
  pendingSince?: number;
  /** When a daemon last restarted for a source change (persisted across restarts). */
  lastRestartAt?: number;
};

/** What to do with the id the source hashes to now. `restart` means: check the new code builds, then restart. */
export function decideSourceRestart(state: SourceRestartState, observedId: string, now: number): { state: SourceRestartState; restart: boolean } {
  if (observedId === state.bootId) return { state: { bootId: state.bootId, lastRestartAt: state.lastRestartAt }, restart: false };
  if (observedId !== state.pendingId) return { state: { ...state, pendingId: observedId, pendingSince: now }, restart: false };
  const settled = now - (state.pendingSince ?? now) >= SOURCE_SETTLE_MS;
  const spaced = state.lastRestartAt === undefined || now - state.lastRestartAt >= SOURCE_RESTART_SPACING_MS;
  return { state, restart: settled && spaced };
}
