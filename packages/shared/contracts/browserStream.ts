// Remote browser watching: the contract between the web viewer
// (packages/web/lib/browserWatchRelay.ts), the Convex relay
// (packages/convex/convex/browserStream.ts) and the daemon's relay loop
// (packages/cli/src/browser/watchRelay.ts).
//
// The browser watch stream's normal transport is a loopback WebSocket to the
// daemon (packages/cli/src/browser/watchServer.ts), which only the machine the
// viewer sits at can reach. This is the second transport, for an agent whose
// browser runs on another of your machines. It is the terminal relay's lease
// protocol (terminalStream.ts) carrying the watch protocol's messages:
//
//   1. The viewer renews a short lease on one row per (device, session). A
//      renewal queues a `stream_browser` daemon command only when no streamer
//      has pushed lately.
//   2. The daemon runs the same watch session the socket runs and pushes the
//      newest JPEG frame, the tab, and the agent's recent actions to the row.
//      The push answer carries the lease, so a lapsed lease stops the loop
//      from the request it was already making.
//   3. Viewer input (control mode) is appended to the row and handed back on
//      the next push answer, cleared in the same transaction: exactly once,
//      and never after the lease that authorized it.
//
// Frames are a few times slower than the socket's: each one is a document
// write, and a viewer only needs to see the page move.
//
// PURE isomorphic data: safe to import from the daemon, Convex and the browser.

/** How long one renewal keeps the daemon streaming. */
export const BROWSER_RELAY_LEASE_MS = 20_000;

/** Viewer renewal cadence: well under the lease, so one dropped round-trip
 *  does not blink the stream off. */
export const BROWSER_RELAY_RENEW_MS = 7_000;

/** At most this often a changed frame is pushed: 2 a second. */
export const BROWSER_RELAY_FRAME_INTERVAL_MS = 500;

/** Push even when nothing changed this often, so the viewer can tell a still
 *  page from a machine that went away, and so queued input is collected. */
export const BROWSER_RELAY_HEARTBEAT_MS = 2_000;

/** While a viewer is driving, the loop pushes this often even with no new
 *  frame: the push is the only thing that collects their clicks and keys. */
export const BROWSER_RELAY_INPUT_POLL_MS = 200;

/** How long one driving renewal keeps the fast poll on. */
export const BROWSER_RELAY_INTERACTIVE_TTL_MS = 16_000;

/** A streamer that has not pushed within this window is presumed gone, and
 *  the next renewal queues a fresh stream_browser command. */
export const BROWSER_RELAY_STREAMER_STALE_MS = 8_000;

/** Never queue stream_browser commands faster than this for one row, so a
 *  sleeping machine does not collect one command per renewal. */
export const BROWSER_RELAY_COMMAND_DEBOUNCE_MS = 5_000;

/** A viewer that has heard nothing from the daemon for this long after asking
 *  says so instead of spinning: the machine is asleep, offline, or runs a cast
 *  that predates this relay. */
export const BROWSER_RELAY_START_TIMEOUT_MS = 25_000;

/** Frame encoding on the relay: smaller than the socket's 1280px at 60, since
 *  every frame is stored. A 1024px JPEG at 50 is typically 40-120 KB. */
export const BROWSER_RELAY_QUALITY = 50;
export const BROWSER_RELAY_MAX_DIM = 1024;

/** A frame larger than this (base64 characters) is not stored; the viewer
 *  keeps the previous one. Well under Convex's 1 MiB document limit. */
export const BROWSER_RELAY_MAX_FRAME_CHARS = 800_000;

/** Input events waiting for the daemon. Reached only when it stopped
 *  collecting, where refusing beats replaying a burst of clicks later. */
export const BROWSER_RELAY_MAX_PENDING_INPUT = 256;

/** The agent actions kept on the row for the cursor overlay. */
export const BROWSER_RELAY_RECENT_ACTIONS = 8;

/** Args of the `stream_browser` daemon command. `key` names the relay row:
 *  the session uuid when known, else the tmux session. */
export interface StreamBrowserArgs {
  key: string;
  session_uuid?: string;
  tmux_session?: string;
}

/** How a relay stream ended, as the daemon reports it: the same codes the
 *  socket sends as `error` and reasons it sends as `exit`. */
export interface BrowserRelayEnd {
  kind: "error" | "exit";
  /** error: no-browser | no-tab | ...; exit: tab-closed | browser-closed | timeout */
  code: string;
  message?: string;
}

/** A session uuid or tmux session name. Both are indexed and passed into
 *  tmux as argv, so this is a sanity clamp, not an injection wall. */
export function isValidBrowserStreamKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_.:@%\-]{1,120}$/.test(key);
}
