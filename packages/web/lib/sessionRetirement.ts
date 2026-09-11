type RetirementStamps = {
  inbox_dismissed_at?: number;
  inbox_killed_at?: number;
  inbox_stashed_at?: number;
};

export function isSessionDismissed(s: Pick<RetirementStamps, "inbox_dismissed_at">): boolean {
  return !!s.inbox_dismissed_at;
}

// Retired: the agent was torn down. A distinct field from inbox_dismissed_at,
// not a synonym. Most kills write both — a hide patch carries
// inbox_dismissed_at and applyHideTransition stamps the marker on top, which
// covers the web's kill action AND `cast kill` (cliSetSessionVisibility patches
// inbox_dismissed_at, then forces the kill transition). The exception is the
// killSession MUTATION (conversations.ts), which stamps inbox_killed_at ALONE:
// that's the path behind the web's convCommand("killSession") — the /sessions
// kill button and the panel's kill-and-complete. Anything asking "is this
// killed?" must read this field or it silently misses those.
export function isSessionKilled(s: Pick<RetirementStamps, "inbox_killed_at">): boolean {
  return !!s.inbox_killed_at;
}

export function isSessionStashed(
  s: Pick<RetirementStamps, "inbox_dismissed_at" | "inbox_stashed_at">,
): boolean {
  // Dismiss wins: a stashed session that later gets dismissed renders in the
  // Dismissed bucket, never both.
  return !!s.inbox_stashed_at && !s.inbox_dismissed_at;
}

