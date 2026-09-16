// Slack mrkdwn ↔ codecast markdown. Pure functions, no I/O, shared by the
// inbound apply path (a Slack line becomes a chat row) and the outbound push
// (a chat row becomes a Slack post). The two directions are not exact inverses
// — Slack has no headers, tables or nested emphasis — but a line that makes the
// round trip must still read as the same sentence, and nothing a Slack person
// typed may turn into a codecast mention of somebody they did not name.

import { emojiToShortcode, replaceShortcodes, shortcodeToEmoji } from "@codecast/shared/chat";

export { emojiToShortcode, replaceShortcodes, shortcodeToEmoji };

// Emoji shortcodes live in @codecast/shared/chat (the full Slack/iamcal set).
// slackToMarkdown calls replaceShortcodes after the other mrkdwn rules.

// ── Entities and code protection ─────────────────────────────────────────────

export function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function encodeSlackEntities(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Code is lifted out before any formatting rule runs and put back after, so a
// `*` inside a snippet never becomes emphasis. Fences first, then spans.
const CODE_TOKEN = "\u0000C";
function protectCode(text: string, onCode: (code: string) => string): { text: string; restore: (s: string) => string } {
  const stash: string[] = [];
  const keep = (code: string) => {
    stash.push(onCode(code));
    return `${CODE_TOKEN}${stash.length - 1}${CODE_TOKEN}`;
  };
  let out = text.replace(/```[\s\S]*?```/g, keep);
  out = out.replace(/`[^`\n]+`/g, keep);
  return {
    text: out,
    restore: (s: string) => s.replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, "g"), (_m, i) => stash[Number(i)]),
  };
}

// ── Slack → codecast ─────────────────────────────────────────────────────────

export type SlackInboundResolver = {
  /** A Slack user id to how the line should name them: a codecast handle when
   *  the person is a mapped teammate (renders as a real mention), else a
   *  display name (renders as bold text so it can never page the wrong
   *  teammate). Null when nothing is known. */
  user: (id: string) => { handle?: string | null; name?: string | null } | null;
  channel?: (id: string) => string | null;
  usergroup?: (id: string) => string | null;
};

// Word-boundary emphasis, the way Slack's own parser decides it: the marker
// must open at a line start or after whitespace/punctuation and close before
// the same, and the wrapped text may not start or end with whitespace.
const OPEN = String.raw`(^|[\s(\[{"'])`;
const CLOSE = String.raw`(?=$|[\s.,!?;:)\]}"'])`;
function emphasisRe(marker: string): RegExp {
  const m = marker.replace(/[*~_]/g, (c) => `\\${c}`);
  return new RegExp(`${OPEN}${m}(?!\\s)([^${m}\\n]*?[^\\s${m}])${m}${CLOSE}`, "g");
}
const BOLD_RE = emphasisRe("*");
const ITALIC_RE = emphasisRe("_");
const STRIKE_RE = emphasisRe("~");

function angleToken(inner: string, resolve: SlackInboundResolver): string {
  // <@U123> / <@U123|name>
  let m = /^@([A-Z0-9]+)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const known = resolve.user(m[1]);
    if (known?.handle) return `@${known.handle}`;
    const name = known?.name || m[2] || m[1];
    // A zero width space after the @ keeps this out of the mention grammar on
    // both server and client: a Slack name must never page a codecast teammate
    // who happens to share it.
    return `**@\u200b${name}**`;
  }
  // <#C123|name> / <#C123>
  m = /^#([A-Z0-9]+)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const name = m[2] || resolve.channel?.(m[1]) || m[1];
    return `#${name}`;
  }
  // <!here> <!channel> <!everyone> <!subteam^S1|@grp> <!date^…|fallback>
  m = /^!([a-z]+)(?:\^([^|]*))?(?:\|(.*))?$/.exec(inner);
  if (m) {
    const kind = m[1];
    if (kind === "here" || kind === "channel" || kind === "everyone") return "@here";
    if (kind === "subteam") {
      const label = m[3] || resolve.usergroup?.(m[2] ?? "") || "group";
      return `**@\u200b${label.replace(/^@/, "")}**`;
    }
    if (kind === "date") return m[3] || m[2] || "";
    return m[3] || "";
  }
  // <mailto:a@b|a@b> / <tel:…|…>
  m = /^(mailto|tel):([^|]*)(?:\|(.*))?$/.exec(inner);
  if (m) return m[3] || m[2];
  // <https://url|label> / <https://url>
  m = /^(https?:\/\/[^|]*)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const url = m[1];
    const label = m[2];
    if (!label || label === url) return url;
    return `[${label}](${url})`;
  }
  return inner;
}

/** Convert one Slack mrkdwn message body to codecast markdown. */
export function slackToMarkdown(text: string, resolve: SlackInboundResolver): string {
  if (!text) return "";
  const { text: protectedText, restore } = protectCode(text, (code) => decodeSlackEntities(code));
  let out = protectedText;
  // Angle tokens carry raw < >; everything else Slack sends is entity-escaped.
  out = out.replace(/<([^<>\n]+)>/g, (_m, inner: string) => angleToken(inner, resolve));
  out = decodeSlackEntities(out);
  out = out.replace(BOLD_RE, "$1**$2**");
  out = out.replace(STRIKE_RE, "$1~~$2~~");
  out = out.replace(ITALIC_RE, "$1*$2*");
  // Slack bullets arrive as "• ", and a leading "# " would become a header here.
  out = out
    .split("\n")
    .map((line) => {
      let l = line.replace(/^(\s*)•\s+/, "$1- ");
      if (/^\s*#{1,6}\s/.test(l)) l = l.replace(/^(\s*)#/, "$1\\#");
      return l;
    })
    .join("\n");
  out = replaceShortcodes(out);
  return restore(out).trim();
}

// Slack "attachments" are the legacy unfurl / bot-card shape (title, text,
// fields, footer). Rendered as a quote card so a GitHub or Linear notification
// mirrored from Slack reads as a card, not as a wall of URLs.
export type SlackAttachment = {
  title?: string;
  title_link?: string;
  text?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  footer?: string;
  image_url?: string;
  thumb_url?: string;
  fields?: Array<{ title?: string; value?: string; short?: boolean }>;
  from_url?: string;
  service_name?: string;
};

export function slackAttachmentsToMarkdown(
  attachments: SlackAttachment[] | undefined,
  resolve: SlackInboundResolver,
): string {
  if (!attachments || attachments.length === 0) return "";
  const cards: string[] = [];
  for (const a of attachments) {
    if (!a || typeof a !== "object") continue;
    const lines: string[] = [];
    if (a.pretext) lines.push(slackToMarkdown(a.pretext, resolve));
    const head: string[] = [];
    if (a.service_name || a.author_name) head.push(`*${a.author_name || a.service_name}*`);
    if (a.title) head.push(a.title_link ? `**[${a.title}](${a.title_link})**` : `**${a.title}**`);
    if (head.length > 0) lines.push(head.join(" · "));
    if (a.text) lines.push(slackToMarkdown(a.text, resolve));
    for (const f of a.fields ?? []) {
      if (!f) continue;
      const t = f.title ? `**${f.title}** ` : "";
      lines.push(`${t}${slackToMarkdown(f.value ?? "", resolve)}`.trim());
    }
    if (a.image_url) lines.push(`![](${a.image_url})`);
    if (a.footer) lines.push(`*${slackToMarkdown(a.footer, resolve)}*`);
    if (lines.length === 0 && a.fallback) lines.push(slackToMarkdown(a.fallback, resolve));
    if (lines.length === 0) continue;
    cards.push(lines.map((l) => l.split("\n").map((x) => `> ${x}`).join("\n")).join("\n>\n"));
  }
  return cards.join("\n\n");
}

// ── codecast → Slack ─────────────────────────────────────────────────────────

export type SlackOutboundResolver = {
  /** A codecast mention handle to the Slack user id it should page, or null. */
  handleToSlackUser: (handle: string) => string | null;
  /** Absolute URL for an object short id (ct-12, pl-3, a session id) so a pill
   *  survives the trip as a link, or null to leave it as text. */
  entityUrl?: (shortId: string) => string | null;
};

const HANDLE_RE = /(^|[^\w/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})\b/g;
const ENTITY_ID_RE = /(^|[^\w-])((?:ct|pl|tr)-\d+)\b/g;

/** Convert codecast markdown to Slack mrkdwn. */
export function markdownToSlack(md: string, resolve: SlackOutboundResolver): string {
  if (!md) return "";
  const { text: protectedText, restore } = protectCode(md, (code) => encodeSlackEntities(code));
  let out = encodeSlackEntities(protectedText);
  // Images and links first: their URLs must not be touched by emphasis rules,
  // and a converted link is shielded so a `ct-12` in its label is not linked
  // a second time by the entity pass below.
  const links: string[] = [];
  const shield = (token: string) => {
    links.push(token);
    return `\u0000L${links.length - 1}\u0000`;
  };
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => shield(`<${url}|${alt || "image"}>`));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => shield(`<${url}|${label}>`));
  // Headers: Slack has none; bold the line.
  out = out.replace(/^(\s*)#{1,6}\s+(.+?)\s*#*$/gm, "$1**$2**");
  // Emphasis. Single-star italic first, with lookarounds that refuse a star
  // that is part of a pair, so the bold made next is not re-read as italic.
  out = out.replace(/(^|[\s(])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)(?=$|[\s.,!?;:)])/gm, "$1_$2_");
  out = out.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "*$1*");
  out = out.replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, "*$1*");
  out = out.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "~$1~");
  // Bullets.
  out = out.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  // Mentions and broadcast.
  out = out.replace(/(^|[^\w/])@here\b/g, "$1<!here>");
  out = out.replace(HANDLE_RE, (whole, pre: string, handle: string) => {
    const uid = resolve.handleToSlackUser(handle.toLowerCase());
    return uid ? `${pre}<@${uid}>` : whole;
  });
  if (resolve.entityUrl) {
    out = out.replace(ENTITY_ID_RE, (whole, pre: string, id: string) => {
      const url = resolve.entityUrl!(id);
      return url ? `${pre}<${url}|${id}>` : whole;
    });
  }
  out = out.replace(/\u0000L(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  return restore(out).trim();
}

/** The name Slack shows over a mirrored codecast line. Agents are marked so a
 *  Slack reader never mistakes a machine for the teammate hosting it. */
export function slackDisplayName(author: { name: string; isAgent?: boolean; via?: string | null }): string {
  const base = author.name.trim() || "Someone";
  if (!author.isAgent) return base.slice(0, 80);
  const via = author.via ? ` · via ${author.via}` : "";
  return `${base} (agent${via})`.slice(0, 80);
}
