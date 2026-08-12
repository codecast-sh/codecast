// Remote pane watching — the contract between the browser's terminal split
// (packages/web/lib/terminal/), the Convex relay (packages/convex/convex/
// terminalStream.ts) and the daemon's capture loop (packages/cli/src/terminal/
// paneStream.ts).
//
// WHY THIS EXISTS. The integrated terminal is a loopback transport: the daemon
// serves a PTY WebSocket on 127.0.0.1 and the browser reaches it only on the
// machine it is physically running on. That is right for a real terminal —
// keystroke latency and byte-rate churn have no business on the sync rail — but
// it means a pane on another of your machines cannot be watched at all, which
// is exactly what people want when an agent runs on a home server or a Mac mini.
//
// So watching is a DIFFERENT transport with different physics. A viewer does
// not need the byte stream; it needs the current screen, which tmux hands over
// whole with `capture-pane -p -e`. Frames go through the rails that already
// carry daemon traffic: a targeted daemon command starts the capture loop, and
// each changed screen is pushed to one reused row. Local panes keep the
// WebSocket; only foreign panes take this path.
//
// LEASES, NOT TEARDOWN. The viewer renews a short lease while it is looking.
// The daemon stops the moment the lease lapses, so a closed tab, a killed
// browser, a lost network and an idle machine all converge on "stop capturing"
// without anyone having to deliver a stop message.
//
// PURE isomorphic data — safe to import from the daemon, the Convex runtime and
// the browser.

/** How long one renewal keeps the daemon capturing. */
export const PANE_LEASE_MS = 20_000;

/** Viewer renewal cadence. Comfortably under the lease so one dropped
 *  round-trip doesn't blink the stream off. */
export const PANE_RENEW_MS = 7_000;

/** How often the daemon re-captures the pane while a lease is live. Fast enough
 *  to read as live typing, slow enough that a busy pane costs a couple of small
 *  writes a second — and an idle pane costs nothing at all, because unchanged
 *  screens are not pushed. */
export const PANE_CAPTURE_INTERVAL_MS = 400;

/** Push even an unchanged screen this often, so the viewer can tell "the pane
 *  is quiet" from "the machine went away". */
export const PANE_HEARTBEAT_MS = 4_000;

/** A streamer that hasn't pushed within this window is presumed gone, and the
 *  next renewal queues a fresh stream_pane command. */
export const PANE_STREAMER_STALE_MS = 6_000;

/** Never queue stream_pane commands faster than this for one pane. Without it,
 *  a machine that is asleep collects one command row per renewal forever. */
export const PANE_COMMAND_DEBOUNCE_MS = 5_000;

/** Frames are screens, not scrollback, so this is generous: a 200x60 pane
 *  drenched in color escapes lands well under it. Truncation is preferable to
 *  a rejected mutation — a clipped screen still reads. */
export const PANE_MAX_FRAME_BYTES = 256_000;

/** Args of the `stream_pane` daemon command. */
export interface StreamPaneArgs {
  target: string;
}

/**
 * tmux target names we are willing to relay.
 *
 * The daemon runs tmux through argument arrays, never a shell string, so this
 * is not the injection wall — it is a sanity clamp that keeps junk out of an
 * indexed field and rejects the tmux format characters that would make
 * capture-pane resolve something other than the pane asked for.
 */
export function isValidPaneTarget(target: string): boolean {
  return /^[A-Za-z0-9_.:@%\-]{1,120}$/.test(target);
}
