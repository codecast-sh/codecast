// The one-line plain text a room's preview, a notification, a toast and a
// push carry. Shared so the server's copy and the copy a client renders from
// the stored row can never disagree.

// Invisible and direction-reversing codepoints. A preview line appears over
// every screen and in a phone banner, where a bidi override could make a message
// read as if a different person or channel sent it. A preview is not a review
// surface, so these are dropped outright rather than surfaced.
export const INVISIBLE_RE =
  /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;

// Strip the codepoints above and flatten to ONE line. Used wherever a name or a
// label written by a user is interpolated into a line somebody else reads: a
// notification body, a push banner, and the speaker labels in the anchor's wake
// prompt. A newline inside a display name is how a name forges a second line.
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

// The one-line PLAIN TEXT excerpt a notification, a toast and a push body carry.
// Never markdown and never HTML: the body is arbitrary text written by teammates
// and by agents, and rendering it as markup in a surface that floats over the
// whole app is a rendering exploit waiting to happen. The full message body goes
// through the app's existing markdown renderer instead, which already sanitizes.
export function plainPreview(content: string, max = 140): string {
  const flattened = content
    .replace(INVISIBLE_RE, "")
    // Fenced code becomes a marker rather than leaking a wall of source.
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]*)`/g, "$1")
    // Images first (they are links with a leading !), then links: keep the text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= max) return flattened;
  return flattened.slice(0, max - 1).trimEnd() + "…";
}
