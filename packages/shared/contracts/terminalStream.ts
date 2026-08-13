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
// TYPING RIDES THE REPLY. Keystrokes go the other way on the request the
// capture loop is ALREADY making: the viewer appends bytes to the row, and the
// next frame push carries them back in its answer and clears them in the same
// transaction. So input costs no extra round-trip in either direction, arrives
// exactly once, and cannot outlive the lease that authorized it.
//
// The cost of that is honesty about latency. A keystroke waits for the next
// capture tick, and its echo waits for the one after — so the loop speeds up
// while someone is typing and settles back when they stop. It reads like a
// shell over a slow link: fine for answering an agent, wrong for vim.
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

/** Capture cadence while someone is actually typing. The push carries input
 *  both ways, so this is also how fast keystrokes are collected — at the
 *  watching cadence the first character of every burst would wait most of a
 *  second, which feels broken rather than remote. */
export const PANE_TYPING_INTERVAL_MS = 100;

/** How long a delivered keystroke keeps the loop at the typing cadence. Long
 *  enough to cover the gap between characters and the pane's reaction to them;
 *  short enough that a burst of typing can't leave the loop fast forever. */
export const PANE_TYPING_WINDOW_MS = 3_000;

/**
 * How often the daemon pushes an UNCHANGED screen while the viewer has the pane
 * focused, instead of the much lazier {@link PANE_HEARTBEAT_MS}.
 *
 * This exists because input can only travel on a push. On a quiet pane nothing
 * changes, so without a floor here the first keystroke of a sentence would sit
 * in the relay until the next heartbeat — four seconds of a dead keyboard,
 * which reads as broken rather than remote. Paying a few small writes a second
 * for a focused terminal buys a keypress-to-pane delay under a quarter second,
 * and an unfocused one still costs nothing.
 */
export const PANE_INPUT_POLL_MS = 250;

/** How long one focused renewal keeps the fast poll alive. Covers a missed
 *  renewal so the cadence doesn't stutter, and expires on its own if the tab
 *  goes away without ever saying it lost focus. */
export const PANE_INTERACTIVE_TTL_MS = 16_000;

/** Cap on bytes waiting to be delivered to one pane. Reached only when the far
 *  daemon has stopped collecting — a machine that slept mid-sentence — where
 *  the honest answer is to refuse the keystroke rather than replay a paragraph
 *  into an agent's prompt minutes later. */
export const PANE_MAX_PENDING_INPUT_BYTES = 4_096;

/** Bytes per `tmux send-keys -H` invocation. Each byte is its own argv entry,
 *  so a large paste has to be split to stay clear of the argument limit. */
export const PANE_INPUT_CHUNK_BYTES = 512;

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

/**
 * Keystrokes travel as lowercase hex.
 *
 * Not the raw string: what xterm hands us is already UTF-8 encoded into char
 * codes 0-255, and putting that in a JSON string field would have the runtime
 * re-encode it — mangling every non-ASCII character and every escape sequence
 * on the way through. Hex survives every hop unexamined, and it makes the
 * daemon's `send-keys -H` argument list a straight slice of the payload.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Inverse of {@link bytesToHex}; null for anything that isn't clean hex, so a
 *  malformed payload is dropped rather than half-typed into a pane. */
export function hexToBytes(hex: string): number[] | null {
  if (hex.length === 0) return [];
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
