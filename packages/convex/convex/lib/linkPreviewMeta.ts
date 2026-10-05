// What a web page says about itself in its <head>: the Open Graph and Twitter
// card tags every chat app reads to draw a link preview, with the plain
// <title>, meta description and favicon behind them. Pure, so the fetcher
// stays a thin shell around it and the tests need no network.

export type LinkPreviewMeta = {
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  favicon?: string;
};

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

function clean(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const t = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Attributes of one tag, names lowercased. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** An absolute https URL, resolved against the page; anything else is dropped
 *  (an http image on an https app is mixed content, data: is not a preview). */
function absoluteHttps(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(decodeEntities(value.trim()), base);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseLinkPreviewMeta(html: string, pageUrl: string): LinkPreviewMeta {
  // Only the head carries these tags; a body can quote markup that looks like them.
  const headEnd = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  let favicon: string | undefined;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
      favicon = absoluteHttps(a.href, pageUrl);
      if (favicon && rel.includes("icon")) break;
    }
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return {
    title: clean(meta["og:title"] ?? meta["twitter:title"] ?? titleTag, 200),
    description: clean(meta["og:description"] ?? meta["twitter:description"] ?? meta["description"], 400),
    image: absoluteHttps(meta["og:image:secure_url"] ?? meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? meta["twitter:image:src"], pageUrl),
    site_name: clean(meta["og:site_name"] ?? meta["application-name"], 80),
    favicon: favicon ?? absoluteHttps("/favicon.ico", pageUrl),
  };
}

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
const PENDING_RETRY_MS = 60 * 1000;

/** Whether a preview row should be fetched again. The card asks before it
 *  calls `linkPreviews.request`, so a fresh row costs no mutation; the
 *  mutation asks again, so a racing second viewer schedules nothing. */
export function linkPreviewStale(
  row: { status: string; requested_at: number; fetched_at?: number } | null | undefined,
  now: number,
): boolean {
  if (!row) return true;
  // Asked within the last minute: a fetch is already on its way.
  if (now - row.requested_at < PENDING_RETRY_MS) return false;
  if (row.status === "pending") return true;
  const age = now - (row.fetched_at ?? row.requested_at);
  return age > (row.status === "failed" ? FAILED_RETRY_MS : FRESH_MS);
}
