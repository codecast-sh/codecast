// A message the daemon is holding because the session runs in a terminal it
// cannot type into (a plain Alacritty window, or a Ghostty whose AppleScript
// is out of reach). The daemon writes the reason as the pending row's hold
// reason, and the web and mobile bubbles show it under the held message.
// Before this the daemon retried such a message as a failure every five
// minutes and said nothing, and the person saw "Connecting..." for nine hours
// (jx72xn9, 2026-11-04).

const PREFIX = "runs in ";
const SUFFIX = ", which Codecast can't type into";

// A hint, when the daemon knows why the terminal is out of reach and what
// clears it, follows after ": " (macOS refused Codecast's Automation request
// for Ghostty on that Mac, 2026-11-08), so the sender is told what to fix.
const HINT_SEPARATOR = ": ";

export function unreachableTerminalHoldReason(terminalLabel: string, hint?: string | null): string {
  const base = `${PREFIX}${terminalLabel}${SUFFIX}`;
  return hint ? `${base}${HINT_SEPARATOR}${hint}` : base;
}

/** The terminal named by an unreachable-terminal hold reason, or null for any other reason. */
export function unreachableTerminalOf(reason: string | null | undefined): string | null {
  if (!reason || !reason.startsWith(PREFIX)) return null;
  const end = reason.indexOf(SUFFIX, PREFIX.length);
  if (end < 0) return null;
  const rest = reason.slice(end + SUFFIX.length);
  if (rest && !rest.startsWith(HINT_SEPARATOR)) return null;
  const label = reason.slice(PREFIX.length, end);
  return label || null;
}
