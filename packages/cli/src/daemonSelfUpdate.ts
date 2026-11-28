// How the daemon updates itself: when a machine below its floor installs, and
// how a round another updater holds is retried. Only the daemon reads this, so
// it stays off index.ts's boot graph (bench/bootGraph.guard.test.ts).

import { isBelowMinimum } from "@platform/cli-kit/update";
import { UPDATE_IN_PROGRESS } from "./update.js";

/**
 * Whether a machine below its floor waits instead of installing: it already
 * runs the release latest.json names (or a newer one). An install would put
 * the same binary back and restart the daemon, which finds itself still below
 * the floor and does it again on every check (a floor set above every
 * published release, ct-102483). It waits until latest.json moves. `latest`
 * null (unread): install, and the install says why it failed.
 */
export function forcedUpdateWaits(current: string, latest: string | null): boolean {
  return latest !== null && !isBelowMinimum(current, latest);
}

/**
 * What the watchdog reports for a force_update it ran before restarting a dead
 * daemon. Another process installing this install (`cast update`, a command's
 * update check) is a deferral, not a failure: that process does the install.
 */
export function watchdogUpdateReport(result: { success: boolean; error?: string }): { result?: string; error?: string } {
  if (result.success) return { result: "Updated by watchdog" };
  if (result.error === UPDATE_IN_PROGRESS) return { result: "Deferred by watchdog: another process is updating this install" };
  return { error: `Watchdog update failed: ${result.error}` };
}

export const UPDATE_DEFER_RETRY_MS = 60_000;
export const UPDATE_DEFER_RETRIES = 5;

/**
 * Run the daemon's self update to an outcome: null when it installed, else
 * the failure the device row shows. Another process installing this install
 * (`cast update`, a command's background check) defers it, and the row stays
 * "installing" while it is tried again a minute later: that process may
 * install a release whose daemon build matches this one's, which restarts
 * nothing, so no later beat would answer the row. After UPDATE_DEFER_RETRIES
 * deferrals in a row it fails, saying why.
 */
export async function selfUpdateOutcome(
  perform: () => Promise<{ success: boolean; error?: string }>,
  opts: { at?: number; onDeferred?: (n: number) => void; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ state: "failed"; error: string; at?: number } | null> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let deferred = 0; ; deferred++) {
    const result = await perform();
    if (result.success) return null;
    if (result.error !== UPDATE_IN_PROGRESS) return { state: "failed", error: String(result.error ?? "unknown error").slice(-500), at: opts.at };
    if (deferred >= UPDATE_DEFER_RETRIES) {
      const minutes = Math.round((UPDATE_DEFER_RETRIES * UPDATE_DEFER_RETRY_MS) / 60_000);
      return { state: "failed", error: `another updater (cast update, or a command's update check) held this install's update lock for ${minutes} minutes; press Retry, or run cast update on the machine`, at: opts.at };
    }
    opts.onDeferred?.(deferred + 1);
    await wait(UPDATE_DEFER_RETRY_MS);
  }
}
