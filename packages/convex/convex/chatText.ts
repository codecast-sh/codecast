// Pure text rules for team chat. No ctx, no db — so bun tests can drive them
// directly and so the send path can never grow a second, looser copy of the
// mention grammar or the preview sanitizer.

// Chat rows sync to every team member's browser and land in IndexedDB on every
// one of their devices, so the content cap is much tighter than the search
// mirror's 32k: one enormous message would degrade the whole team's client.
export const MAX_CHAT_CONTENT = 8_000;
export const MAX_CHANNEL_NAME = 64;
export const MAX_CHANNEL_TOPIC = 200;
export const MAX_ATTACHMENTS = 10;
export const MAX_MENTIONS = 20;
export const MAX_EMOJI_LENGTH = 32;
// Per message. Past the cap a reaction write is dropped rather than growing the
// set forever — a message with 24 distinct emoji has already made its point.
export const MAX_DISTINCT_EMOJI = 24;
export const MAX_CHANNELS_PER_TEAM = 200;
// Unread badges are capped and rendered as "50+". Convex has no count
// aggregate, so an uncapped count would pull a channel's whole backlog for a
// number nobody reads past two digits.
export const UNREAD_CAP = 50;
// How recently someone must have typed to count as "here".
export const HERE_PRESENCE_MS = 10 * 60_000;

// A channel name is a slug: lowercase, words joined by dashes. It is a display
// label only — routing is by _id, because two concurrent creates can both pass
// a uniqueness read and a name that resolves to a row would then be ambiguous.
export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_NAME);
}

// A mention handle as WRITTEN. Resolution to a user happens server-side against
// the team roster (chat.ts resolveMentions) — this only says which words in the
// text were addressed to somebody.
//
// `@here` is a scope, not a person, so it is reported separately. `@channel` is
// not supported: on a team small enough to share one codecast workspace it is
// `@here` with worse manners.
const MENTION_RE = /(?:^|[^\w/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})/g;

export function extractMentionHandles(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const handle = match[1].toLowerCase();
    if (handle === "here" || handle === "channel" || handle === "everyone") continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

export function mentionsHere(content: string): boolean {
  return /(?:^|[^\w/])@here\b/i.test(content);
}

// Bots are addressed by their display name (an anchor's name is set by a team
// admin, so it is not a handle an ordinary member can squat). Humans are never
// matched on their display name — that IS user-editable, and matching it would
// let anyone rename themselves to intercept a teammate's mentions.
export function botHandle(name: string | undefined): string | null {
  if (!name) return null;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return slug.length > 0 ? slug : null;
}

// Invisible and direction-reversing codepoints. A preview line appears over
// every screen and in a phone banner, where a bidi override could make a message
// read as if a different person or channel sent it. A preview is not a review
// surface, so these are dropped outright rather than surfaced.
const INVISIBLE_RE =
  /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;

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

// ONE emoji, matched by shape rather than by a list of banned characters. A
// reaction key is stored as written and rendered as text under every message, so
// an allow-list is the only honest gate: a deny-list would still admit
// "notanemoji" or ":shrug:" and turn the reaction row into a second, unmoderated
// message field.
//
// The four shapes a real reaction takes: a keycap (1️⃣), a flag (two regional
// indicators), a pictograph with optional skin tone and variation selector, and
// a ZWJ sequence of those (🏳️‍🌈, 👨‍👩‍👧‍👦). Two pictographs side by side are NOT
// one emoji and are refused.
const EMOJI_RE =
  /^(?:[0-9#*]️?⃣|\p{Regional_Indicator}\p{Regional_Indicator}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)*(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)*)*)$/u;

export function isValidEmoji(emoji: string): boolean {
  if (!emoji || emoji.length > MAX_EMOJI_LENGTH) return false;
  return EMOJI_RE.test(emoji);
}

// The one permalink shape for a chat message, written here so the notification
// row, the push payload and the CLI all print the same URL. The channel is the
// path because a channel is the page; the message is a query parameter because it
// is a position inside that page, not a different page.
export function chatPermalink(channelId: string, messageId?: string): string {
  return messageId ? `/chat/${channelId}?m=${messageId}` : `/chat/${channelId}`;
}
