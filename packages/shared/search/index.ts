// Text search primitives shared by the server scan (messages.findAllMessagesByContent),
// the transcript renderer (marks in markdown and code) and the global search
// box, so a hit means the same thing everywhere it is counted or drawn.

/** Split a search box's text into lowercase terms; a quoted phrase is one term. */
export function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

/** Non-overlapping, case-insensitive substring hits of every term in `content`. */
export function countMatches(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (!term) continue;
    let pos = 0;
    while ((pos = lower.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
  }
  return count;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
const LINK_REFERENCE = /^ {0,3}\[[^\]\n]+\]:\s*\S.*$/gm;
// `![alt](dest)` draws an image, `[text](dest)` draws only its text; the
// destination (and an optional "title") never reaches the page.
const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;

function dropLinkTargets(prose: string): string {
  return prose.replace(LINK_REFERENCE, "").replace(IMAGE, "").replace(LINK, "$1");
}

/**
 * The text of a markdown body that the transcript actually draws, as far as
 * search is concerned: link and image destinations and reference definitions
 * are dropped, code (fenced or inline) is kept as written. The server counts
 * hits in this text, so the counter only promises hits the renderer can mark.
 */
export function drawnText(markdown: string): string {
  if (!markdown.includes("](") && !markdown.includes("]:")) return markdown;
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flushProse = () => {
    if (prose.length === 0) return;
    const text = prose.join("\n");
    let last = 0;
    let rebuilt = "";
    for (const m of text.matchAll(INLINE_CODE)) {
      rebuilt += dropLinkTargets(text.slice(last, m.index)) + m[0];
      last = m.index! + m[0].length;
    }
    out.push(rebuilt + dropLinkTargets(text.slice(last)));
    prose = [];
  };
  for (const line of markdown.split("\n")) {
    const open = FENCE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = null;
    } else if (open) {
      flushProse();
      out.push(line);
      fence = open;
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return out.join("\n");
}

export { tokenizeQuery, normalizeQueryQuotes, type QueryToken } from "./tokenize";
export * from "./sessionQuery";
export * from "./terms";
