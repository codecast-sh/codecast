// What the desktop update card offers, from what the updater reports.

/**
 * Whether the card shows the retry state ("Update failed" or "taking longer
 * than usual", with Try again).
 *
 * Never once the update is staged. `updating` stays set after the download
 * ends, so the 90s no-progress timer still fires on a finished update: the
 * card then offered Try again beside Restart now, and the two buttons left
 * its message a column a few characters wide, drawn over the composer.
 */
export function updateNeedsRetry(s: {
  /** The update is downloaded and waits for a restart. */
  ready: boolean;
  /** No progress for 90s while an update was in flight. */
  stalled: boolean;
  /** The updater reported a failure. */
  errored: boolean;
  /** This window asked for the update. */
  updating: boolean;
  /** A newer version is known to exist. */
  known: boolean;
}): boolean {
  if (s.ready) return false;
  return s.stalled || (s.errored && (s.updating || s.known));
}
