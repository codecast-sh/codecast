// The self update's one retry (update.ts performUpdate loads it on demand).

/** A download that disagrees with the manifest it was read against: a CDN
 *  serving the new manifest before the new binary (1.1.263, 2026-11-23). */
export const isReleaseRace = (error?: string): boolean =>
  !!error && (error.startsWith("checksum_mismatch_") || error === "download_incomplete");

/** One updater run, and one more after a pause when the download raced the
 *  manifest. Each run loads the manifest again, so the retry checks the binary
 *  against what the release says now. */
export async function updateWithRetry(
  run: () => Promise<{ success: boolean; error?: string; version?: string }>,
  pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, 5000)),
): Promise<{ success: boolean; error?: string; version?: string }> {
  const first = await run();
  if (first.success || !isReleaseRace(first.error)) return first;
  console.error(`Update download did not match the release (${first.error}); fetching the manifest again`);
  await pause();
  return run();
}
