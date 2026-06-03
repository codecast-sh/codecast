// Parses "★ Insight ─────" callout blocks out of assistant markdown so they can
// render as styled cards instead of falling through to plain text.
//
// The model emits the *idea* of an insight in several surface forms, so we match
// the structural signature — a starred header line ending in a long rule, a body,
// and a closing rule line — rather than one exact byte pattern. Specifically we
// tolerate:
//   - rule lines wrapped in nothing, `backticks`, or **bold**
//   - a custom title after the star: `★ Insight ─ Why it broke ─────`
//   - lone \r line breaks (react-markdown silently drops these, mashing the text)
//
// Rule runs are box-drawing / em-dash glyphs only (never the ASCII hyphen) and
// must be 5+ long, so ordinary markdown `---` thematic breaks and `| --- |`
// tables can never be mistaken for an insight rule.
//
// Deliberately NOT matched: the open-ended titled form that has a header line but
// no closing rule (`★ Insight ─ Title ───` then prose to end-of-message). It has
// no safe delimiter, and degrading it to readable text is better than guessing a
// body boundary and swallowing unrelated content into a card.

export type InsightPart =
  | { type: 'text'; content: string }
  | { type: 'insight'; label: string; content: string };

const RULE = '[─━═—–]';
const WRAP = '(?:`|\\*\\*)?';
const HRULE = `${WRAP}[ \\t]*${RULE}{5,}[ \\t]*${WRAP}`;
const INSIGHT_BLOCK_RE = new RegExp(
  `(?:^|\\n)[ \\t]*${WRAP}[ \\t]*([★✦⭐☆✨])[ \\t]+([^\\n\`]*?)[ \\t]*${RULE}{5,}[ \\t]*${WRAP}[ \\t]*(?:\\n|$)` +
    `([\\s\\S]*?)` +
    `(?:^|\\n)[ \\t]*${HRULE}[ \\t]*(?=\\n|$)`,
  'g',
);

const TRIM_RULE_RE = /^[\s─━═—–]+|[\s─━═—–]+$/g;

export function cleanInsightLabel(raw: string): string {
  const label = raw.replace(TRIM_RULE_RE, '').trim();
  // "Insight — Custom title" → surface the custom title
  const titled = label.match(/^insight\s*[─━═—–-]\s*(.+)$/i);
  return (titled ? titled[1] : label || 'Insight').trim();
}

export function formatInsightBody(raw: string): string {
  // Bullet glyphs aren't markdown list markers; map them to real list items so
  // the card body renders as a list rather than a run-together paragraph.
  return raw.replace(/^([ \t]*)[•·‣◦]\s+/gm, '$1- ').trim();
}

export function parseInsightBlocks(text: string): InsightPart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const src = text.replace(/\r\n?/g, '\n');
  const parts: InsightPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INSIGHT_BLOCK_RE.lastIndex = 0;
  while ((match = INSIGHT_BLOCK_RE.exec(src)) !== null) {
    const before = src.slice(lastIndex, match.index).trim();
    if (before) parts.push({ type: 'text', content: before });
    parts.push({
      type: 'insight',
      label: cleanInsightLabel(match[2]),
      content: formatInsightBody(match[3]),
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < src.length) {
    const remaining = src.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: src });
  return parts;
}
