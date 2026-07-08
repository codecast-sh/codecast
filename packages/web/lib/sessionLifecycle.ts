// The single rule for "what is a fresh, still-empty session doing right now —
// booting, ready, or genuinely not connecting?" Both the composer
// (ConversationView) and the inbox row (GlobalSessionPanel) render a new session's
// startup affordance from THIS function so they can never disagree.
//
// The bug it fixes: the composer said "Ready" while the inbox row spun
// "Starting…" for a full two minutes and then degraded to "Waiting for
// connection" — for the very same session.
//
// The key design choice (inherited from the composer): elapsed time is a fallback
// for the daemon heartbeat. A freshly-created blank session often doesn't register
// a heartbeat until its first message is sent, so `is_connected` stays false even
// though the session is perfectly usable. Rather than trap the UI on a signal that
// may never arrive, we trust the session is Ready once a short startup grace has
// passed, and only call it "stalled" after a long window with still no connection.

export type SessionStartupState = "starting" | "ready" | "stalled";

// Boot window — show the spinner. Matches the composer's isSessionStarting cutoff.
export const SESSION_STARTING_GRACE_MS = 30_000;
// After this long with no heartbeat at all, the daemon really isn't coming. Matches
// the composer's isSessionReady upper bound, where it hands off to the disconnected
// banner.
export const SESSION_STALL_THRESHOLD_MS = 120_000;

export function sessionStartupState(opts: {
  isConnected?: boolean;
  ageMs: number;
}): SessionStartupState {
  if (opts.isConnected) return "ready";
  if (opts.ageMs < SESSION_STARTING_GRACE_MS) return "starting";
  if (opts.ageMs < SESSION_STALL_THRESHOLD_MS) return "ready";
  return "stalled";
}
