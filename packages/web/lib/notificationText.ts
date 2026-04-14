export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\*{1,2}/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/`+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
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
