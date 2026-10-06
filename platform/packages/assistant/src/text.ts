// HTML as plain text, for anything that reads a web page or an HTML mail:
// scripts, styles and comments dropped, block tags turned into line breaks,
// every other tag removed and entities decoded. Pure and dependency free.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes HTML character references: named basics and numeric ones. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// Every tag pattern bounds its attribute run, so a stray "<" in a long text
// costs one short scan instead of a scan to the end of the page.
const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|blockquote|pre|hr|dt|dd)\b[^<>]{0,2000}>/gi;
const ANY_TAG = /<[^<>]{1,2000}>/g;
const HIDDEN_OPEN = /<(script|style|noscript|template|svg|head)\b[^<>]{0,2000}>/gi;

// Drops each hidden element with its body. An element left open hides the
// rest of the text, the way a browser would; one indexOf per element keeps
// the walk linear.
function dropHidden(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let from = 0;
  HIDDEN_OPEN.lastIndex = 0;
  for (let m = HIDDEN_OPEN.exec(html); m; m = HIDDEN_OPEN.exec(html)) {
    out += html.slice(from, m.index) + " ";
    const close = lower.indexOf(`</${m[1].toLowerCase()}`, HIDDEN_OPEN.lastIndex);
    if (close === -1) return out;
    const end = html.indexOf(">", close);
    from = end === -1 ? html.length : end + 1;
    HIDDEN_OPEN.lastIndex = from;
  }
  return out + html.slice(from);
}

/**
 * A page or an HTML mail as readable plain text: scripts, styles and comments
 * dropped, block tags turned into line breaks, every other tag removed,
 * entities decoded and runs of blank space collapsed. Text only, never markup,
 * so what the assistant reads cannot carry a live link or a hidden element.
 */
export function htmlToText(html: string): string {
  const bodyAt = html.search(/<body\b/i);
  const body = bodyAt === -1 ? html : html.slice(bodyAt);
  return decodeEntities(
    dropHidden(body.replace(/<!--[\s\S]*?(?:-->|$)/g, " "))
      .replace(BLOCK_TAGS, "\n")
      .replace(ANY_TAG, " "),
  )
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
