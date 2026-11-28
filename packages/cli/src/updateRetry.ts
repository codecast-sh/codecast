// The self update's one retry and its lock (update.ts performUpdate loads
// this on demand).

import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { acquireFileLock } from "./lockFile.js";
import { UPDATE_IN_PROGRESS } from "./update.js";

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

// Two downloads at curl's 180 s bound, the retry's pause and the codesign
// checks, with room to spare: a holder older than this was killed mid-update.
const UPDATE_LOCK_STALE_MS = 15 * 60_000;

/**
 * Run one update holding the update lock, or skip the round when another
 * updater holds it. The updater downloads to one fixed `<binary>.new`, so two
 * at once (the daemon's forced update beside a `cast` command's background
 * check, on a busy machine) truncate each other's download into a checksum
 * mismatch and delete it from under each other (ENOENT), and neither installs
 * (ct-102415). A dead holder's lock is reclaimed (lockFile.ts). The lock
 * takes no signal handlers: the daemon's own SIGTERM handler would otherwise
 * run twice (once re-raised by the lock); the release rides `exit` and the
 * finally instead.
 */
export async function exclusiveUpdate<T extends { success: boolean; error?: string }>(
  lockFile: string,
  run: () => Promise<T>,
): Promise<T | { success: false; error: typeof UPDATE_IN_PROGRESS }> {
  // A directory we cannot write beside the binary is no other updater: run, and let the update say why it failed.
  try { accessSync(dirname(lockFile), constants.W_OK); } catch { return run(); }
  let release: () => void;
  try {
    release = await acquireFileLock(lockFile, { waitMs: 0, staleMs: UPDATE_LOCK_STALE_MS, what: "update", signals: false });
  } catch {
    return { success: false, error: UPDATE_IN_PROGRESS };
  }
  try {
    return await run();
  } finally {
    release();
  }
}
