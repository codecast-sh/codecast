// The two timeouts that decide whether a graceful daemon stop stays graceful.
//
// They belong together because they are a pair: `cast stop` and `cast restart`
// send SIGTERM and then SIGKILL after their own deadline, so anything the
// daemon does on the way out has to finish well inside it. A flush budget equal
// to the kill deadline means the caller kills the daemon in exactly the case
// the flush was added for, and the kill skips the pid file release, the
// daemon.version and daemon.build cleanup and the stop lifecycle log.
//
// No imports on purpose: both the CLI and the daemon read this.

/** How long `cast stop` waits after SIGTERM before it sends SIGKILL. */
export const DAEMON_STOP_SIGKILL_MS = 10_000;

/** How long shutdown spends draining the retry queue. Small enough that the
 *  rest of shutdown still fits inside DAEMON_STOP_SIGKILL_MS. */
export const SHUTDOWN_FLUSH_MS = 3_000;
