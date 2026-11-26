// Pure logic behind the message navigator (prompt list, hidden-row chip, tick
// minimap) and the sticky prompt banner. Shared by the web popover
// (components/MessageBrowserPopover.tsx), ConversationView's sticky prompt and
// the iOS session screen, so it must stay free of DOM and React imports. The
// session title lookup is injected because each platform has its own store.

import { isTurnInterruptionNotice } from "@codecast/shared/contracts";
import { isCommandMessage, cleanContent } from "./conversationProcessor";
import { isStickyEligible, stickyPromptContent, stickyEligibleIds, commandBodyInvocationIndex } from "./stickyPrompt";
import {
  parseMachineDeliveredMessage,
  isBareNudge,
  type MachineDeliveredKind,
} from "../components/sessionMessage";
import { NAV_ROW_SNIPPET_CHARS, stripContextTags, filterUserMessages, type FilterableMessage } from "@codecast/convex/convex/userMessagesFilter";
import type { PromptImage } from "./messagePreview";
import { formatShortDate } from "./utils";
import { directUserOf } from "../components/conversation/classify";
import { resolveMessageSender, type SenderContext } from "./messageSender";

export { isStickyEligible, stickyPromptContent, stickyEligibleIds };

// Row kinds hidden behind the "other" chip: machine-delivered messages plus
// bare "continue" nudges the human typed — navigation noise either way.
export type HiddenKind = MachineDeliveredKind | "continue";
export type NavigatorRowKind = "user" | HiddenKind;

export type NavigatorRow = {
  _id: string;
  display: string;
  images?: PromptImage[];
  isCmd: boolean;
  timestamp: number;
  commentCount: number;
  kind: NavigatorRowKind;
  source?: string;
  // Human-message ordinal (what the row numbers show); hidden-kind rows carry
  // -1 and render unnumbered.
  originalIndex: number;
  // The source content reached the server's snippet cap, so `display` may be
  // a prefix of the real body. The hover card resolves the full body then.
  clipped: boolean;
  // Who sent a human row: the account that sent it, the name a wrapper
  // carries (`<user-message from="Cam">`), and whether the viewer just sent
  // it (no account on it yet). resolveNavigatorAuthors turns them into one
  // author per row.
  fromUserId?: string;
  wireFrom?: string;
  pending?: boolean;
};

export type NavigatorSourceMessage = { _id: string; content?: string; timestamp: number; images?: PromptImage[]; from_user_id?: string; pending?: boolean };

export const MACHINE_KIND_LABEL: Record<HiddenKind, string> = {
  schedule: "trigger", // user-facing vocabulary is "trigger" (ct-38953); the kind key mirrors the wire tag
  session: "session",
  teammate: "teammate",
  chat: "chat",
  continue: "continue",
};

function getCommandLabel(content: string): string | null {
  const m = content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
  const name = m?.[1].replace(/^\//, "").trim();
  if (!name) return null;
  const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  return `/${name}${args ? ` ${args}` : ""}`;
}

export function processUserMessage(content: string): { display: string; isCmd: boolean } {
  const isCmd = isCommandMessage(content);
  if (isCmd) {
    // A command tag with an empty name carries no information, so it falls
    // back to the cleaned content like an unlabeled command.
    return { display: getCommandLabel(content) ?? cleanContent(content), isCmd: true };
  }
  return { display: cleanContent(content), isCmd: false };
}

// Zero width characters survive String.trim, so a message made only of them
// passes the blank test yet renders as an ordinal with no visible text.
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS, "");
}

// A raw wire payload ("{\"type\":\"idle_notification\",...}") is noise as a row
// body; the type field names the event, so show that in plain words instead.
// Anything that fails to parse keeps the raw body.
function humanizeWirePayload(body: string): string {
  if (!body.startsWith("{")) return body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed.type.replace(/_/g, " ");
    }
  } catch {
    // not JSON after all; fall through to the raw body
  }
  return body;
}

// Chip/tooltip noun for the hidden rows: precise when they're all one kind
// ("2 sessions", "1 trigger"), neutral when mixed — "automated" would mislabel
// a teammate or another session messaging in.
export function hiddenRowsNoun(rows: { kind: NavigatorRowKind }[]): string {
  const kinds = new Set(rows.map((m) => m.kind));
  if (kinds.size === 1) {
    const noun = MACHINE_KIND_LABEL[rows[0].kind as HiddenKind];
    return rows.length === 1 ? noun : `${noun}s`;
  }
  return "other";
}

// One person who sent human rows in this conversation.
export type NavigatorAuthor = {
  key: string;
  // The person's own name, and what a row shows: "You" for the viewer, else
  // their first name (the whole name when two people here share one).
  name: string;
  label: string;
  image?: string | null;
  // 0 is the unmarked voice: the viewer when they wrote here (the question
  // a reader asks is "who besides me?"), else the session's owner. Everyone
  // else counts up from 1 in the order they first wrote. Each platform maps
  // a tone to one color, so a person's rail ticks and face match.
  tone: number;
  count: number;
};

// The color each tone wears, in order, as a Solarized accent name: web reads
// `var(--sol-<name>)`, the phone `Theme[<name>]`, so a person has one color on
// both. Tone 0, the unmarked voice, has none.
const AUTHOR_TONE_NAMES = ["cyan", "magenta", "green", "violet", "yellow"] as const;
export type AuthorToneName = (typeof AUTHOR_TONE_NAMES)[number];
export function authorToneName(tone: number): AuthorToneName | null {
  return tone > 0 ? AUTHOR_TONE_NAMES[(tone - 1) % AUTHOR_TONE_NAMES.length] : null;
}

// The tone as a theme color for the web, shared by a person's rail ticks and face.
export function authorToneColor(tone: number): string | undefined {
  const name = authorToneName(tone);
  return name ? `var(--sol-${name})` : undefined;
}

/** "your" for the viewer, else "Cam’s": how the filter's placeholder and chips name a person's messages. */
export function possessive(author: NavigatorAuthor): string {
  return author.label === "You" ? "your" : `${author.label}\u2019s`;
}

export type NavigatorAuthorship = {
  byRow: Map<string, NavigatorAuthor>;
  // The unmarked voice first, then in the order they first wrote.
  authors: NavigatorAuthor[];
  // Someone besides the owner wrote here. Only then do rows name a sender:
  // a thread its owner wrote alone needs no name on every line.
  attributed: boolean;
};

// Who sent each human row, through the same resolver the transcript's
// bubbles use (lib/messageSender), so a row and its bubble name one person.
export function resolveNavigatorAuthors(rows: NavigatorRow[], ctx: SenderContext): NavigatorAuthorship {
  const ownerKey = ctx.ownerId ?? "owner";
  const viewerId = ctx.viewerId;
  // Pass 1: each row's sender as a key, name and face.
  const picks: { row: NavigatorRow; key: string; name: string; image?: string | null }[] = [];
  const keyByName = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "user") continue;
    const sender = resolveMessageSender(row, ctx);
    picks.push({ row, ...sender });
    if (!sender.key.startsWith("name:") && sender.name !== "Someone") keyByName.set(sender.name.toLowerCase(), sender.key);
  }
  // Pass 2: a name a wrapper carries joins the account of that name, so one
  // person is one author however each of their rows arrived.
  const keyOf = (pick: (typeof picks)[number]) => (pick.key.startsWith("name:") ? keyByName.get(pick.name.toLowerCase()) ?? pick.key : pick.key);
  const plainKey = viewerId && picks.some((p) => keyOf(p) === viewerId) ? viewerId : ownerKey;
  const byKey = new Map<string, NavigatorAuthor>();
  const byRow = new Map<string, NavigatorAuthor>();
  let nextTone = 1;
  for (const pick of picks) {
    const key = keyOf(pick);
    let a = byKey.get(key);
    if (!a) {
      a = { key, name: pick.name, label: viewerId && key === viewerId ? "You" : pick.name, image: pick.image, tone: key === plainKey ? 0 : nextTone++, count: 0 };
      byKey.set(key, a);
    }
    if (!a.image && pick.image) a.image = pick.image;
    a.count++;
    byRow.set(pick.row._id, a);
  }
  const authors = [...byKey.values()].sort((a, b) => a.tone - b.tone);
  const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
  for (const a of authors) {
    if (a.label !== a.name) continue;
    const first = firstName(a.name);
    if (!authors.some((o) => o !== a && firstName(o.name).toLowerCase() === first.toLowerCase())) a.label = first;
  }
  return { byRow, authors, attributed: authors.some((a) => a.key !== ownerKey) };
}

export function formatTimeAgo(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;
  return formatShortDate(ts);
}

// Build the navigator rows from the complete user-message list. Machine-delivered
// messages (cast send, teammate broadcasts, schedule triggers) list as compact
// subdued rows rather than being dropped; human rows keep their numbering
// regardless. Bare "continue" nudges bucket with the machine rows: unnumbered,
// hidden until the chip reveals them. The kind label carries the word, so the
// body would be pure repetition — it is dropped. A `cast send` wire tag carries
// only the sender's short id; `resolveSessionTitle` maps it to a title when the
// platform's store knows the session. A slash command's body (the batch that
// follows its invocation) is not a prompt of its own: the invocation's row
// already stands for it.
export function buildNavigatorRows(
  userMessages: NavigatorSourceMessage[],
  commentCounts?: Map<string, number> | null,
  resolveSessionTitle?: (shortId: string) => string | null,
  loadedImages?: Readonly<Record<string, PromptImage[] | undefined>>,
): NavigatorRow[] {
  let humanOrdinal = 0;
  const rows: NavigatorRow[] = [];
  for (let i = 0; i < userMessages.length; i++) {
    const m = userMessages[i];
    if (commandBodyInvocationIndex(userMessages, i) >= 0) continue;
    const content = m.content ?? "";
    const images = m.images ?? loadedImages?.[m._id];
    if (isTurnInterruptionNotice(content)) continue;
    const commentCount = commentCounts?.get(m._id) || 0;
    const clipped = content.length >= NAV_ROW_SNIPPET_CHARS;
    const machine = parseMachineDeliveredMessage(content);
    if (machine) {
      const sourceText =
        machine.kind === "session"
          ? resolveSessionTitle?.(machine.source) ?? machine.source
          : machine.source;
      const display = humanizeWirePayload(machine.body);
      // A trigger title is usually the prompt's first line, so the source
      // line would only repeat the body; drop it when the body already
      // carries it. Session sources are titles, never the body.
      const source = display.toLowerCase().startsWith(sourceText.toLowerCase()) ? undefined : sourceText;
      rows.push({ _id: m._id, ...(images?.length ? { images } : {}), display, isCmd: false, timestamp: m.timestamp, commentCount, kind: machine.kind, source, originalIndex: -1, clipped });
      continue;
    }
    const user = processUserMessage(content);
    if (!user.isCmd && isBareNudge(user.display)) {
      rows.push({ _id: m._id, display: "", isCmd: false, timestamp: m.timestamp, commentCount, kind: "continue", originalIndex: -1, clipped: false });
      continue;
    }
    if (stripInvisible(user.display).trim().length === 0 && !images?.length) continue;
    const wireFrom = directUserOf(content.trim())?.from;
    rows.push({
      _id: m._id, ...(images?.length ? { images } : {}), ...user, timestamp: m.timestamp, commentCount, kind: "user", originalIndex: humanOrdinal++, clipped,
      ...(m.from_user_id ? { fromUserId: m.from_user_id } : {}),
      ...(wireFrom ? { wireFrom } : {}),
      ...(m.pending ? { pending: true } : {}),
    });
  }
  return rows;
}

// The display text a row would carry if it were built from `fullContent`
// (a raw transcript body: context tags still attached) instead of the server
// snippet. Same pipeline as the row itself, so a machine row keeps its
// humanized body and a slash command keeps its label. Falls back to the
// snippet when the full body would not produce a row.
export function navigatorRowBody(
  row: NavigatorRow,
  fullContent: string | undefined,
  resolveSessionTitle?: (shortId: string) => string | null,
): string {
  if (fullContent === undefined) return row.display;
  const [rebuilt] = buildNavigatorRows(
    [{ _id: row._id, content: stripContextTags(fullContent), timestamp: row.timestamp, images: row.images }],
    undefined,
    resolveSessionTitle,
  );
  return rebuilt?.display || row.display;
}

// Header numbers both navigator surfaces show: the human prompt count (search
// placeholder, tab label) and the hidden-row chip label. Derived from the full
// row list so the chip and the placeholder always agree.
export function navigatorHeaderLabels(rows: NavigatorRow[]): {
  humanCount: number;
  hiddenCount: number;
  placeholder: string;
  chipLabel: string;
} {
  const hidden = rows.filter((r) => r.kind !== "user");
  const humanCount = rows.length - hidden.length;
  return {
    humanCount,
    hiddenCount: hidden.length,
    placeholder: `Search ${humanCount} message${humanCount === 1 ? "" : "s"}`,
    chipLabel: hidden.length > 0 ? `${hidden.length} ${hiddenRowsNoun(hidden)}` : "",
  };
}

// Fold a conversation's comment summary into a per-message count map (the
// number badge on navigator rows). Entries without a message id are
// conversation-level comments and don't count against any row.
export function countCommentsByMessage(
  summary: { message_id?: unknown }[] | null | undefined,
): Map<string, number> | null {
  if (!summary) return null;
  const map = new Map<string, number>();
  for (const c of summary) {
    if (!c.message_id) continue;
    const mid = String(c.message_id);
    map.set(mid, (map.get(mid) || 0) + 1);
  }
  return map;
}

// `authors` (from resolveNavigatorAuthors) narrows to one person's rows when
// `authorKey` names one, and lets a search for a name find what they sent.
export function filterNavigatorRows(
  rows: NavigatorRow[],
  { search, showHidden, authors, authorKey }: { search: string; showHidden: boolean; authors?: NavigatorAuthorship; authorKey?: string | null },
): NavigatorRow[] {
  let pool = showHidden ? rows : rows.filter((m) => m.kind === "user");
  if (authorKey && authors) pool = pool.filter((m) => authors.byRow.get(m._id)?.key === authorKey);
  if (!search) return pool;
  const q = search.toLowerCase();
  const nameOf = (m: NavigatorRow) => {
    const a = authors?.attributed ? authors.byRow.get(m._id) : undefined;
    return a ? `${a.label} ${a.name}` : "";
  };
  return pool.filter((m) => `${m.display} ${m.source ?? ""} ${nameOf(m)}`.toLowerCase().includes(q));
}

// Where the first case insensitive hit of `query` sits in `text`, or -1.
export function matchIndex(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  return text.toLowerCase().indexOf(q);
}

// A search result clamped to two lines can hide the term it matched on. When
// the first hit starts past `radius` characters, return the text from a word
// boundary shortly before the hit, prefixed with an ellipsis, so the reader
// sees why the row matched. Short rows and early hits keep their normal
// start; no hit returns the text unchanged.
export function matchSnippet(text: string, query: string, radius: number = 40): string {
  const hit = matchIndex(text, query);
  if (hit <= radius) return text;
  let start = hit - radius;
  const boundary = text.lastIndexOf(" ", start);
  if (boundary > 0 && hit - boundary <= radius * 2) start = boundary + 1;
  return "\u2026" + text.slice(start).trimStart();
}

export type NavigatorTick<R> = { row: R; active: boolean };

// The fewest ticks each author gets on a rail too short for every row, so a
// person who wrote a few messages in a thread someone else dominates still
// shows up on it.
const TICKS_PER_AUTHOR = 4;

// Sample up to `max` rows for the minimap. Below the cap every row gets a
// tick. Above it, with `authorOf`, each author gets a share of the ticks by
// how many rows they wrote, never fewer than TICKS_PER_AUTHOR (or all of
// theirs), spread evenly over their own rows; without it, or with one author,
// the ticks spread evenly over the whole list, first and last row included.
// The active row lights the tick nearest it, so a row between two sampled
// ones still shows where you are.
export function sampleTicks<R>(
  rows: R[],
  max: number,
  activeIndex: number = -1,
  authorOf?: (row: R) => string,
): NavigatorTick<R>[] {
  const all = rows.map((_, i) => i);
  const picked = rows.length <= max ? all : authorOf ? sampleByAuthor(rows, max, authorOf) : spread(all, max);
  let lit = -1;
  if (activeIndex >= 0) {
    picked.forEach((i, k) => {
      if (lit < 0 || Math.abs(i - activeIndex) < Math.abs(picked[lit] - activeIndex)) lit = k;
    });
  }
  return picked.map((i, k) => ({ row: rows[i], active: k === lit }));
}

// `n` of `indices`, evenly spaced, keeping the first and last.
function spread(indices: number[], n: number): number[] {
  if (n >= indices.length) return indices;
  if (n <= 1) return indices.slice(0, n);
  return Array.from({ length: n }, (_, k) => indices[Math.round((k / (n - 1)) * (indices.length - 1))]);
}

function sampleByAuthor<R>(rows: R[], max: number, authorOf: (row: R) => string): number[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = authorOf(row);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  const lists = [...groups.values()];
  if (lists.length === 1 || lists.length > max) return spread(rows.map((_, i) => i), max);
  const floor = Math.min(TICKS_PER_AUTHOR, Math.floor(max / lists.length));
  const slots = lists.map((list) => Math.min(list.length, floor));
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
  // The ticks left over go by each author's share of the rows not yet
  // ticked, largest remainders first.
  const spare = max - sum(slots);
  const left = lists.map((list, g) => list.length - slots[g]);
  const exact = left.map((n) => (n * spare) / sum(left));
  exact.forEach((x, g) => (slots[g] += Math.floor(x)));
  let rest = max - sum(slots);
  const byRemainder = exact.map((x, g) => [x - Math.floor(x), g]).sort((a, b) => b[0] - a[0]);
  for (const [, g] of byRemainder) {
    if (rest <= 0) break;
    if (slots[g] < lists[g].length) { slots[g]++; rest--; }
  }
  return lists.flatMap((list, g) => spread(list, slots[g])).sort((a, b) => a - b);
}

// The bar under the tick minimap the active tick lands on, from the current
// message or, when it is not a navigator row, the scroll progress.
export function activeTickIndex(rows: { _id: string }[], currentMessageId: string | null, scrollProgress: number): number {
  const total = rows.length;
  const currentIndex = currentMessageId ? rows.findIndex((m) => m._id === currentMessageId) : -1;
  return currentIndex >= 0 ? currentIndex : Math.min(total - 1, Math.floor(scrollProgress * total));
}

export type StickySourceMessage = {
  _id: string;
  role?: string;
  content: string;
  timestamp: number;
  from_user_id?: string;
};

// The latest prompt that is NOT in the loaded window and sits between the
// prompt the window resolved (afterTs) and the top visible row (beforeTs).
// The sticky header shows the latest prompt at or above what the reader is
// looking at; the window can only resolve prompts it holds, so a later one it
// does not hold (scrolled past every loaded prompt, a window that reaches far
// back through one early row, a gap) has to come from the full prompt list
// or the header falls back to an older prompt, as far back as the opening one.
// `eligibleIds` is stickyEligibleIds over the same list; callers that resolve
// on every scroll pass it memoized.
export function pickStickyFallback(
  userMessages: StickySourceMessage[] | null | undefined,
  loadedIds: Set<string>,
  beforeTs: number,
  afterTs = -Infinity,
  eligibleIds: Set<string> = stickyEligibleIds(userMessages ?? []),
): { id: string; content: string; fromUserId?: string; timestamp: number } | null {
  if (!userMessages || userMessages.length === 0) return null;
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const msg = userMessages[i];
    if (msg.timestamp <= afterTs) return null;
    if (msg.role !== "user" || msg.timestamp >= beforeTs) continue;
    if (loadedIds.has(msg._id) || !eligibleIds.has(msg._id)) continue;
    return { id: msg._id, content: msg.content, fromUserId: msg.from_user_id, timestamp: msg.timestamp };
  }
  return null;
}

// Active sticky prompt = the latest sticky-worthy row at or above the top
// visible row. It is hidden while that row is itself on screen: the reader
// can see the prompt, so the banner would only repeat it.
export function resolveStickyPrompt(
  stickyIndices: number[],
  topVisibleIndex: number,
  visibleIndexSet: Set<number>,
): { index: number; hidden: boolean } | null {
  for (let i = stickyIndices.length - 1; i >= 0; i--) {
    const idx = stickyIndices[i];
    if (idx <= topVisibleIndex) return { index: idx, hidden: visibleIndexSet.has(idx) };
  }
  return null;
}

// Union the complete (but scan-capped) user-message cache with the loaded
// transcript window. The cache is newest-first capped, so the opening prompts
// of a long thread can be missing from it while still sitting on screen —
// those loaded rows have to join the navigator or #1 is a later prompt.
export function mergeNavigatorSources(
  cached: NavigatorSourceMessage[] | null | undefined,
  loaded: Array<{
    _id: string;
    role?: string;
    content?: string;
    timestamp: number;
    images?: PromptImage[];
    tool_results?: FilterableMessage["tool_results"];
    subtype?: string;
    from_user_id?: string;
    _isOptimistic?: boolean;
    _isQueued?: boolean;
  }> | null | undefined,
): NavigatorSourceMessage[] {
  const byId = new Map<string, NavigatorSourceMessage>();
  for (const m of cached ?? []) byId.set(m._id, m);
  const extras: FilterableMessage[] = [];
  const pendingIds = new Set<string>();
  for (const m of loaded ?? []) {
    if (m.role !== "user") continue;
    const existing = byId.get(m._id);
    if (existing) {
      const loadedContent = m.content ?? "";
      if (loadedContent.length > (existing.content?.length ?? 0)) {
        byId.set(m._id, { ...existing, content: loadedContent, images: m.images ?? existing.images });
      }
      continue;
    }
    extras.push({
      _id: m._id,
      role: "user",
      content: m.content,
      timestamp: m.timestamp,
      images: m.images,
      tool_results: m.tool_results,
      subtype: m.subtype,
      from_user_id: m.from_user_id,
    });
    if (m._isOptimistic || m._isQueued) pendingIds.add(m._id);
  }
  for (const m of filterUserMessages(extras)) {
    byId.set(m._id, {
      _id: m._id, content: m.content, timestamp: m.timestamp, images: m.images,
      ...(m.from_user_id ? { from_user_id: m.from_user_id } : {}),
      ...(pendingIds.has(m._id) ? { pending: true } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id));
}

export type ViewportRect = { index: number; top: number; bottom: number };

// First timeline row whose box intersects the viewport, plus every intersecting
// index. Overscan rows above the viewport have bottom <= viewportTop and are
// not visible. Used by both the sticky banner and the navigator current row.
export function topVisibleIndexFromRects(
  items: ViewportRect[],
  viewportTop: number,
  viewportBottom: number,
): { topVisibleIndex: number; visible: Set<number> } {
  const visible = new Set<number>();
  let topVisibleIndex = -1;
  for (const item of items) {
    if (item.bottom > viewportTop && item.top < viewportBottom) {
      visible.add(item.index);
      if (topVisibleIndex < 0) topVisibleIndex = item.index;
    }
  }
  if (topVisibleIndex < 0) {
    for (const item of items) {
      if (item.bottom > viewportTop) {
        topVisibleIndex = item.index;
        break;
      }
    }
  }
  return { topVisibleIndex, visible };
}

// Navigator current = the latest navigator row at or above the top visible
// timeline row. Unlike the sticky banner, this stays set when that row is
// itself on screen — the list has to highlight what the reader is looking at,
// including the opening prompt at scrollTop 0.
export function resolveNavigatorCurrentId(
  navigatorIndices: number[],
  timelineIds: Array<string | null | undefined>,
  topVisibleIndex: number,
  fallbackId: string | null,
): string | null {
  if (navigatorIndices.length === 0) return fallbackId;
  const resolved = resolveStickyPrompt(navigatorIndices, topVisibleIndex, new Set());
  if (resolved) {
    const id = timelineIds[resolved.index];
    return typeof id === "string" && id.length > 0 ? id : fallbackId;
  }
  if (fallbackId) return fallbackId;
  if (topVisibleIndex >= 0 && topVisibleIndex < navigatorIndices[0]) {
    const id = timelineIds[navigatorIndices[0]];
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}
