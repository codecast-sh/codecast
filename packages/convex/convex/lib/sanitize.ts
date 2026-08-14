// Sanitizing publisher-controlled text before it is stored and rendered.
//
// The mirror stores names and descriptions written by whoever published a
// skill or plugin, and renders them into a browser AND into `cast cap show`,
// which an agent reads. Snyk's audit of public skills found 76 confirmed
// malicious ones surviving marketplace review, 91% via prompt injection — so
// the threat here is not markup, it is instructions. Escaping angle brackets
// does nothing to "ignore previous instructions"; what helps is (1) never
// letting control characters through, (2) bounding length, and (3) making the
// RENDERER fence foreign text with provenance (the CLI's fence helper) so a
// reader — human or model — can see where the untrusted region begins and ends.
//
// Shape follows sanitizeSshHost (devices.ts): exported pure function, null for
// REJECTED input, so a call site can distinguish "cleaned" from "refused" and
// store the refusal as a fact instead of an empty string that looks like data.

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
