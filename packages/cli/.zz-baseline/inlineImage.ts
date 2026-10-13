/**
 * How a `cast` command hands an image to the conversation.
 *
 * Screenshots taken through the Chrome extension appear inline in the thread
 * because an MCP tool can return an `image` content block, which the parser
 * lifts onto the message and the web binds back to the tool that produced it.
 * A shell command has no such channel: its tool result is a string, and Bash
 * output is rendered verbatim inside a `<pre>`, so a markdown image printed
 * there shows up as literal text.
 *
 * This closes that gap without inventing a second rendering path. A command
 * prints one marker line naming the file it wrote; the transcript parser turns
 * that into the same `{ localPath, toolUseId }` image the Codex bridge already
 * produces, and everything downstream — upload, dedupe by path and mtime,
 * storage id, `ToolBlock` → `ImageBlock` — is machinery that already exists.
 * The marker is stripped from the displayed output, so the human sees the
 * command's normal text with the picture under it.
 *
 * Only ever emit this for a file the command itself just wrote.
 */

/** Recognisable, unlikely to occur by accident, and readable if it ever leaks. */
const MARKER_OPEN = "⁢cast:image ";
const MARKER_CLOSE = "⁢";

// Anchored to whole lines: a marker is emitted on its own line, and matching
// mid-line would let arbitrary prose that quotes the syntax inject an image.
const MARKER_LINE = /^⁢cast:image (.+?)⁢[ \t]*$/gm;

/** The line a command prints to put `absPath` inline under its output. */
export function inlineImageMarker(absPath: string): string {
  return `${MARKER_OPEN}${absPath}${MARKER_CLOSE}`;
}

export interface ExtractedInlineImages {
  /** The text with marker lines removed, for display. */
  text: string;
  /** Absolute paths, in the order they appeared, deduplicated. */
  paths: string[];
}

/**
 * Pull image markers out of tool output.
 *
 * Returns the cleaned text and the paths, so the caller can attach the images
 * and show the output without the marker. Paths are NOT validated here — the
 * sync layer already stats each one, rejects anything that is not a readable
 * image under the size cap, and drops it quietly if it has gone away.
 */
export function extractInlineImages(text: string): ExtractedInlineImages {
  if (!text || !text.includes(MARKER_OPEN)) return { text, paths: [] };
  const paths: string[] = [];
  const seen = new Set<string>();
  const cleaned = text.replace(MARKER_LINE, (_match, p: string) => {
    const abs = p.trim();
    // Only absolute paths: a relative one would resolve against whatever
    // directory the sync process happens to be in, which is not the one the
    // command ran in.
    if (abs.startsWith("/") && !seen.has(abs)) {
      seen.add(abs);
      paths.push(abs);
    }
    return "";
  });
  if (!paths.length) return { text, paths: [] };
  // Collapse the blank line the removed marker leaves behind.
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trimEnd(), paths };
}
