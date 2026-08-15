// Sanitizing publisher-controlled text — the ONE implementation.
//
// Two writers need it: the convex ingest (before storing catalog/report text)
// and the CLI's skill emitter (before frontmatter reaches a model on a machine
// we write). Living here keeps it one function; the history of this codebase
// says two copies of a sanitizer diverge exactly where it matters. See
// convex/lib/sanitize.ts for the original threat write-up (Snyk: 76 malicious
// skills, 91% prompt injection — the defense is bounds + provenance fencing,
// never phrase filtering).

/** The Skills API's own description cap; anything longer is truncated, not rejected. */
export const MAX_FOREIGN_TEXT_LENGTH = 1024;

/**
 * Clean one foreign string for storage.
 *
 * Returns the cleaned string, or null when the input is not honestly text:
 * non-string, empty after trim, or carrying control characters. Control chars
 * are a REJECTION rather than a strip because a payload that needed ESC or NUL
 * was not prose — stripping would silently store a lie about what was sent.
 * Newlines and tabs survive (real descriptions have them); everything else
 * below 0x20, plus DEL and the C1 range, rejects.
 */
export function sanitizeForeignText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(input)) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= MAX_FOREIGN_TEXT_LENGTH) return trimmed;
  // Truncation is marked so a reader knows the text is not what the publisher
  // wrote — an unmarked cut could end mid-sentence in a way that changes meaning.
  return trimmed.slice(0, MAX_FOREIGN_TEXT_LENGTH - 1) + "…";
}
