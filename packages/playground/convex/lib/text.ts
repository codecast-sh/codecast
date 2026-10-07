// Text as the room, the timeline and the builder show it: one line, and cut
// with a mark when it runs long. Shared by the backend, the shell and the SDK.

/** Whitespace runs collapsed to single spaces, trimmed. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** At most `max` characters, an ellipsis marking a cut. */
export function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** One line, at most `max` characters. */
export function clipLine(s: string, max: number): string {
  return clipText(oneLine(s), max);
}
