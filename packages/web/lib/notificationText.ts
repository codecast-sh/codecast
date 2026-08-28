import { entityMentionRegex } from "./entityLinks";

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

const INSIGHT_BLOCK_RE = /`?[★⭐]\s*Insight[\s\S]*?─{5,}`?/g;
const BOX_DRAWING_LINE_RE = /^[\s`]*[─━┄┈]{3,}[\s`]*$/gm;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const XML_TAG_RE = /<[^>]+>/g;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function cleanNotificationBody(text: string, maxLen = 180): string {
  if (!text) return "";
  const stripped = text
    .replace(INSIGHT_BLOCK_RE, "")
    .replace(CODE_FENCE_RE, "")
    .replace(BOX_DRAWING_LINE_RE, "")
    .replace(XML_TAG_RE, "")
    .replace(ANSI_RE, "");
  const cleaned = stripMarkdown(stripped).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * A session's last_message_preview is a raw transcript slice, so it can carry
 * machine framing — <task-notification>, <task-id>…</task-id>, a tag cut
 * midway by the preview length limit, ANSI color. Strip that down to whatever
 * a person would actually read; an empty result means the caller should drop
 * the preview line entirely rather than show framing debris.
 */
export function stripTranscriptTags(text: string): string {
  if (!text) return "";
  // A preview that carries machine framing is a machine message end to end —
  // a task notification, a system reminder, a teammate envelope. The tag
  // CONTENTS (tool-use ids, output-file paths) are as unreadable as the tags,
  // so there is nothing worth salvaging: drop the whole preview.
  if (/<(task-notification|system-reminder|teammate-message|session-message|task-id|tool-use|output-file|command-name)\b/i.test(text)) {
    return "";
  }
  return text
    .replace(/<\/?[a-z!][^>]*>/gi, "")
    .replace(/<\/?[a-z!][^>]*$/i, "")
    .replace(ANSI_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const LEADING_H1_RE = /^#\s+.+\n+/;

/**
 * A doc body for rendering under a header that already shows the doc's title:
 * frontmatter and the leading H1 drop (both would duplicate the chrome), the
 * markdown itself stays intact. Used by the expanded doc card.
 */
export function docBodyMarkdown(content: string | undefined | null): string {
  if (!content) return "";
  return content.replace(FRONTMATTER_RE, "").replace(LEADING_H1_RE, "");
}
// Shared mention shape: strips `@[Title id]` down to its display text.
const ENTITY_MENTION_RE = entityMentionRegex();

/**
 * Multi-line plain-text peek at a doc body for hover cards: drops frontmatter,
 * code fences, and the leading H1 (it duplicates the card title), resolves
 * @[Title id] entity mentions to their display text, and keeps paragraph
 * breaks — unlike notification strings, which flatten to one line.
 */
export function docContentPreview(content: string | undefined | null, maxLen = 700): string {
  if (!content) return "";
  const body = content
    .replace(FRONTMATTER_RE, "")
    .replace(LEADING_H1_RE, "")
    .replace(INSIGHT_BLOCK_RE, "")
    .replace(CODE_FENCE_RE, "")
    .replace(BOX_DRAWING_LINE_RE, "")
    .replace(XML_TAG_RE, "")
    .replace(ANSI_RE, "")
    .replace(ENTITY_MENTION_RE, "$1");
  const cleaned = stripMarkdown(body, { keepNewlines: true });
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).trimEnd() + "…";
}
