

// How long a sent message may sit in the optimistic/pending state before the
// message row surfaces a status hint. Normal delivery confirms in a few seconds.
// Past this we show "queued · agent busy" while the agent is actively working
// (the daemon defers injection until the turn ends — the message WILL land), and
// only escalate to "hasn't reached / kill & restart" when the agent is idle.
export const PENDING_RETRY_AFTER_MS = 20_000;

// Extra grace after the agent flips busy→idle before the kill & restart
// escalation may appear: the daemon injects deferred messages within its next
// poll once the turn ends, so a message that's been pending behind a long turn
// shouldn't flash "hasn't reached the agent" the instant the agent goes idle.
// The window is generous on purpose — an idle pane is the ordinary state a
// message gets delivered INTO, so a few slow daemon passes are not evidence of
// a loss, and the calm "queued" line covers the wait.
export const PENDING_IDLE_GRACE_MS = 45_000;

// A booting / resuming / freshly-connected session legitimately takes far longer
// than a turn to begin processing the first message, so the per-message banner
// stays calm ("queued") this long before escalating to the alarming kill & restart.
// Mirrors the composer banner's startup/resume thresholds so the two agree.
export const PENDING_BOOT_GRACE_MS = 60_000;     // starting / connected: session launch budget
export const PENDING_RESUME_GRACE_MS = 120_000;  // resuming is the slowest path
