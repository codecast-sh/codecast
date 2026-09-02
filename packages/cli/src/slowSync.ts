// Reports for synchronous work that held the event loop.
//
// A blocked loop is a blocked loop: timers, delivery and heartbeats all wait
// whether the loop is inside a child process or inside a filesystem walk.
// Sync spawns were timed through proc.ts from the start; sync filesystem work
// (tree walks, whole file reads, sqlite opens) was never timed, and it is the
// larger of the two on a machine with tens of thousands of transcripts. One
// sink and one message shape serve both, so the log report and the freeze
// SLO read them the same way.

export type SlowSyncTag = "SLOW-SYNC-SPAWN" | "SLOW-SYNC-FS";

export const SLOW_SYNC_SPAWN_MS = 1_000;
// Filesystem work is finer grained than a spawn: one walk of the transcript
// tree is ~50ms warm, so anything past this is the disk being contended.
export const SLOW_SYNC_FS_MS = 250;

let slowSyncSink: ((message: string) => void) | null = null;

export function setSlowSyncSink(sink: ((message: string) => void) | null): void {
  slowSyncSink = sink;
}

/**
 * Run `fn` and, when it held the loop for `thresholdMs` or longer, report it
 * through the sink. Reports in `finally`, so a throwing `fn` is still named.
 * `detail` is lazy so a report that never fires costs no string building.
 */
export function timeSync<T>(
  tag: SlowSyncTag,
  thresholdMs: number,
  name: string,
  detail: string | (() => string),
  fn: () => T,
): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= thresholdMs && slowSyncSink) {
      try {
        const d = typeof detail === "function" ? detail() : detail;
        slowSyncSink(`[${tag}] ${name} blocked the event loop ${Math.round(elapsedMs)}ms: ${d}`);
      } catch {}
    }
  }
}

export function timeSyncFs<T>(name: string, detail: string | (() => string), fn: () => T): T {
  return timeSync("SLOW-SYNC-FS", SLOW_SYNC_FS_MS, name, detail, fn);
}
