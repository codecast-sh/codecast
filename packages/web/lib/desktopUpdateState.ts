// What the desktop update card shows, from what the updater reports.

/**
 * The card's state. `requested` (this window asked for the update) is never
 * cleared by a finished download, so it cannot mean "working" by itself: a
 * staged update is not in progress, whoever asked for it. Counting it as one
 * kept the 90s no-progress timer armed on a finished update, and the card then
 * offered Try again beside Restart now, the two buttons leaving its message a
 * column a few characters wide over the composer.
 */
export function updateCardState(s: {
  /** The updater's last report: "downloading", "ready", "error", or none yet. */
  status: string | undefined;
  /** This window asked for the update. */
  requested: boolean;
  /** No progress for 90s while an update was in progress. */
  stalled: boolean;
  /** A newer version is known to exist. */
  known: boolean;
}) {
  const ready = s.status === "ready";
  const downloading = s.status === "downloading";
  const errored = s.status === "error";
  const updating = s.requested && !ready;
  const inProgress = updating || downloading;
  // `stalled` is about a run in progress; the flag itself is cleared an effect
  // later than the run ends.
  const showStalled = (inProgress && s.stalled) || (errored && (updating || s.known));
  return { ready, downloading, errored, updating, inProgress, showStalled };
}
