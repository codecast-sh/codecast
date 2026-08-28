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
export const MAX_EMOJI_LENGTH = 32;
// Per message. Past the cap a reaction write is dropped rather than growing the
// set forever — a message with 24 distinct emoji has already made its point.
export const MAX_DISTINCT_EMOJI = 24;
export const MAX_CHANNELS_PER_TEAM = 200;
// Membership caps. A "private channel" with 300 people is a public channel
// with extra steps; a group DM past a handful of faces is a channel that wants
// a name.
export const MAX_CHANNEL_MEMBERS = 100;
export { MAX_DM_MEMBERS } from "@codecast/shared/chat";
// Unread badges are capped and rendered as "50+". Convex has no count
// aggregate, so an uncapped count would pull a channel's whole backlog for a
// number nobody reads past two digits.
export const UNREAD_CAP = 50;
// How far back a DM rail row looks for the newest line from the other person.
// Bounded for the same reason as the unread cap: a long run of the viewer's own
// sends must not turn one rail read into a full backlog scan.
export const DM_INBOUND_SCAN = 50;
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
// The vocabulary itself lives in @codecast/shared/chat/handles so the clients'
// completion strips and this server resolve the SAME handles. Re-exported here
// so convex-side callers keep one import path.
export { MAX_MENTIONS, extractMentionHandles, mentionsHere, botHandle, emailLocalHandle, memberHandle } from "@codecast/shared/chat";

// Invisible and direction-reversing codepoints. A preview line appears over
// every screen and in a phone banner, where a bidi override could make a message
// read as if a different person or channel sent it. A preview is not a review
// surface, so these are dropped outright rather than surfaced.
const INVISIBLE_RE =
  /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;

// Strip the codepoints above and flatten to ONE line. Used wherever a name or a
// label written by a user is interpolated into a line somebody else reads: a
// notification body, a push banner, and the speaker labels in the anchor's wake
// prompt. A newline inside a display name is how a name forges a second line.
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

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

/** A search snippet: the plain text WINDOWED around the first term hit, so a
 *  match deep in a long message still shows the words that matched — a head
 *  slice would render such a hit with nothing highlighted, which reads as a
 *  false positive. Falls back to the head when no term is found in the plain
 *  text (the index may have matched a stemmed form). */
export function searchSnippet(content: string, query: string, max = 200): string {
  const plain = plainPreview(content, MAX_CHAT_CONTENT);
  if (plain.length <= max) return plain;
  const lower = plain.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0 || first < max * 0.6) return plain.slice(0, max - 1).trimEnd() + "…";
  // Lead with a little context, land the hit inside the window, cut on a space.
  let start = Math.max(0, first - Math.floor(max * 0.3));
  const spaceBefore = plain.lastIndexOf(" ", start);
  if (spaceBefore > 0 && start - spaceBefore < 20) start = spaceBefore + 1;
  const end = Math.min(plain.length, start + max - 2);
  return "…" + plain.slice(start, end).trim() + (end < plain.length ? "…" : "");
}

// ── The fence around untrusted text in an agent prompt ──────────────────────
//
// The anchor's wake prompt quotes chat written by other people into a prompt
// that runs on somebody's laptop with a shell. A FIXED delimiter cannot hold
// that: the quoted text is written by the same people the fence is meant to
// contain, so anyone can type the closing marker and continue below it as if
// they were the system. Both halves of every quoted line are attacker-written —
// the body AND the speaker's display name, which every member edits freely.
//
// So the marker carries a nonce minted per wake, the surrounding sentence names
// that nonce, and every quoted line is scrubbed of anything that looks like a
// marker. Guessing the nonce is the only way to close the fence early, and the
// caller never sees it.
export function fenceMarker(kind: "begin" | "end", nonce: string): string {
  return `--- ${kind} thread ${nonce} ---`;
}

const FENCE_LIKE_RE = /-{2,}\s*(?:begin|end)\s+thread[^\n]*/gi;

// One quoted line, safe to put inside the fence: no marker, no invisible
// codepoints, no extra newlines that could fake a speaker change.
export function fenceSafe(text: string, max = MAX_CHAT_CONTENT): string {
  const scrubbed = text
    .replace(INVISIBLE_RE, "")
    .replace(FENCE_LIKE_RE, "[marker removed]")
    // A quoted body may run to several lines; each one is indented so it can
    // never be read as a new speaker.
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n  ")
    .trim();
  return scrubbed.length <= max ? scrubbed : scrubbed.slice(0, max - 1) + "…";
}

// ── Per-channel notify level ────────────────────────────────────────────────
//
// The ONE place that says what a level means, so the server's gate and the
// client's toast tier can never drift into two different mutes.
//   all      — every chat event this channel produces, including a chat_post
//              for every ordinary line. Slack's "All new posts": an OS banner
//              and a phone push per message, by explicit opt-in only.
//   mentions — what is addressed to you: a direct @you, @here, a reply on a
//              thread you are in, a DM line, an invite. Slack's default
//              ("direct messages, mentions & keywords" + thread replies).
//              A DM at "mentions" still notifies — every DM line IS addressed
//              to you; only "none" silences a DM room.
//   none     — nothing
export function notifyLevelAllows(
  level: "all" | "mentions" | "none" | undefined,
  eventType: "chat_mention" | "chat_reply" | "chat_here" | "chat_dm" | "chat_added" | "chat_post",
): boolean {
  if (eventType === "chat_post") return level === "all";
  return level !== "none";
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
