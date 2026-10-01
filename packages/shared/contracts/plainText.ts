// Agent and doc text reduced to what a person reads or hears: notification
// lines, the call's reply peek, hover previews, and the words an agent's face
// speaks in a call all come from here, so none of them can disagree about
// what counts as markup.

const INSIGHT_BLOCK_RE = /`?[★⭐]\s*Insight[\s\S]*?─{5,}`?/g;
const BOX_DRAWING_LINE_RE = /^[\s`]*[─━┄┈]{3,}[\s`]*$/gm;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const XML_TAG_RE = /<[^>]+>/g;
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Drop what only a machine reads: insight boxes, code fences, box-drawing
 *  rules, tags and terminal colour. */
export function stripMachineText(text: string): string {
  return text
    .replace(INSIGHT_BLOCK_RE, "")
    .replace(CODE_FENCE_RE, "")
    .replace(BOX_DRAWING_LINE_RE, "")
    .replace(XML_TAG_RE, "")
    .replace(ANSI_RE, "");
}

export function stripMarkdown(text: string, opts?: { keepNewlines?: boolean }): string {
  const stripped = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\*{1,2}/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/`+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "");
  // Notification strings flatten to one line; multi-line previews (doc hover)
  // keep paragraph shape, collapsing runs of blank lines to one break.
  return (opts?.keepNewlines ? stripped.replace(/\n{3,}/g, "\n\n") : stripped.replace(/\n+/g, " ")).trim();
}

/** One plain line of an agent's words. */
export function plainAgentLine(text: string): string {
  if (!text) return "";
  return stripMarkdown(stripMachineText(text)).replace(/\s+/g, " ").trim();
}

export function cleanNotificationBody(text: string, maxLen = 180): string {
  const cleaned = plainAgentLine(text);
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trimEnd() + "…";
}

/** An agent's reply as speech: the same plain line, ending on a whole
 *  sentence within `maxLen` so a long answer stops cleanly rather than
 *  mid-word. The full reply stays in the call's chat. */
export function speakableAgentLine(text: string, maxLen = 600): string {
  const plain = plainAgentLine(text);
  if (plain.length <= maxLen) return plain;
  const head = plain.slice(0, maxLen);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  return end > maxLen / 3 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(" "))}…`;
}
