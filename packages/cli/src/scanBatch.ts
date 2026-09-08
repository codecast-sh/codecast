/**
 * The two things every batched tree walk needs, and nothing else (ct-49758).
 *
 * `scanClient.ts` used to hold them, which meant that a plain filesystem walk
 * — no worker anywhere near it — pulled the worker client in, and through it
 * the host, the frame protocol and every payload validator. That is thirteen
 * modules on `cast --help` for two lines of code.
 *
 * They are named "scan" because a scan is what they interrupt, not because a
 * scan worker is involved: `fsWalk.ts` throws `ScanCancelled` on its own
 * readdir loop and awaits `yieldScanBatch` between its own stat batches.
 *
 * This file imports nothing on purpose. Anything added here is paid by every
 * invocation of the CLI and by the daemon.
 */

/** Thrown when the caller's signal aborted, or the reason for the walk went
 *  away mid-flight (the root moved, a generation counter advanced). */
export class ScanCancelled extends Error {}

/** Hand the event loop back between batches. A walk that never yields pins the
 *  loop for as long as the disk takes, and nothing is delivered meanwhile. */
export const yieldScanBatch = () => new Promise<void>((resolve) => setImmediate(resolve));
