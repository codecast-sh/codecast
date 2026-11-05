// A message the daemon is holding because the session runs in a terminal it
// cannot type into (a plain Alacritty window, or a Ghostty whose AppleScript
// is out of reach). The daemon writes the reason as the pending row's hold
// reason, and the web and mobile bubbles show it under the held message.
// Before this the daemon retried such a message as a failure every five
// minutes and said nothing, and the person saw "Connecting..." for nine hours
// (jx72xn9, 2026-11-04).

const PREFIX = "runs in ";
const SUFFIX = ", which Codecast can't type into";

export function unreachableTerminalHoldReason(terminalLabel: string): string {
  return `${PREFIX}${terminalLabel}${SUFFIX}`;
}

/** The terminal named by an unreachable-terminal hold reason, or null for any other reason. */
export function unreachableTerminalOf(reason: string | null | undefined): string | null {
  if (!reason || !reason.startsWith(PREFIX) || !reason.endsWith(SUFFIX)) return null;
  const label = reason.slice(PREFIX.length, reason.length - SUFFIX.length);
  return label || null;
}
