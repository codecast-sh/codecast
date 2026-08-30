// Pure logic behind the message navigator (prompt list, hidden-row chip, tick
// minimap) and the sticky prompt banner. Shared by the web popover
// (components/MessageBrowserPopover.tsx), ConversationView's sticky prompt and
// the iOS session screen, so it must stay free of DOM and React imports. The
// session title lookup is injected because each platform has its own store.

import { isCommandMessage, cleanContent, isSystemMessage } from "./conversationProcessor";
import {
  parseMachineDeliveredMessage,
  isBareNudge,
  stickyPromptContent,
  type MachineDeliveredKind,
} from "../components/sessionMessage";

// Row kinds hidden behind the "other" chip: machine-delivered messages plus
// bare "continue" nudges the human typed — navigation noise either way.
export type HiddenKind = MachineDeliveredKind | "continue";
export type NavigatorRowKind = "user" | HiddenKind;

export type NavigatorRow = {
  _id: string;
  display: string;
  isCmd: boolean;
  timestamp: number;
  commentCount: number;
  kind: NavigatorRowKind;
  source?: string;
  // Human-message ordinal (what the row numbers show); hidden-kind rows carry
  // -1 and render unnumbered.
  originalIndex: number;
};

export type NavigatorSourceMessage = { _id: string; content?: string; timestamp: number };

export const MACHINE_KIND_LABEL: Record<HiddenKind, string> = {
  schedule: "trigger", // user-facing vocabulary is "trigger" (ct-38953); the kind key mirrors the wire tag
  session: "session",
  teammate: "teammate",
  chat: "chat",
  continue: "continue",
};

function getCommandLabel(content: string): string | null {
  const m = content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
  return m ? `/${m[1].replace(/^\//, "")}` : null;
}

export function processUserMessage(content: string): { display: string; isCmd: boolean } {
  const isCmd = isCommandMessage(content);
  if (isCmd) {
    const label = getCommandLabel(content);
    // A command tag with an empty name reduces to a bare "/": no information,
    // so fall back to the cleaned content like an unlabeled command.
    return { display: label && label !== "/" ? label : cleanContent(content), isCmd: true };
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

export function formatTimeAgo(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Build the navigator rows from the complete user-message list. Machine-delivered
// messages (cast send, teammate broadcasts, schedule triggers) list as compact
// subdued rows rather than being dropped; human rows keep their numbering
// regardless. Bare "continue" nudges bucket with the machine rows: unnumbered,
// hidden until the chip reveals them. The kind label carries the word, so the
// body would be pure repetition — it is dropped. A `cast send` wire tag carries
// only the sender's short id; `resolveSessionTitle` maps it to a title when the
// platform's store knows the session.
export function buildNavigatorRows(
  userMessages: NavigatorSourceMessage[],
  commentCounts?: Map<string, number> | null,
  resolveSessionTitle?: (shortId: string) => string | null,
): NavigatorRow[] {
  let humanOrdinal = 0;
  const rows: NavigatorRow[] = [];
  for (const m of userMessages) {
    const content = m.content ?? "";
    const commentCount = commentCounts?.get(m._id) || 0;
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
      rows.push({ _id: m._id, display, isCmd: false, timestamp: m.timestamp, commentCount, kind: machine.kind, source, originalIndex: -1 });
      continue;
    }
    const user = processUserMessage(content);
    if (!user.isCmd && isBareNudge(user.display)) {
      rows.push({ _id: m._id, display: "", isCmd: false, timestamp: m.timestamp, commentCount, kind: "continue", originalIndex: -1 });
      continue;
    }
    if (stripInvisible(user.display).trim().length === 0) continue;
    rows.push({ _id: m._id, ...user, timestamp: m.timestamp, commentCount, kind: "user", originalIndex: humanOrdinal++ });
  }
  return rows;
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

export function filterNavigatorRows(
  rows: NavigatorRow[],
  { search, showHidden }: { search: string; showHidden: boolean },
): NavigatorRow[] {
  const pool = showHidden ? rows : rows.filter((m) => m.kind === "user");
  if (!search) return pool;
  const q = search.toLowerCase();
  return pool.filter((m) => `${m.display} ${m.source ?? ""}`.toLowerCase().includes(q));
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

// Sample up to `max` evenly spaced rows for the minimap. Below the cap every
// row gets a tick; above it the ticks map onto the row list by rounding, so
// the first and last rows always have one.
export function sampleTicks<R>(rows: R[], max: number, activeIndex: number = -1): NavigatorTick<R>[] {
  const total = rows.length;
  const displayCount = Math.min(total, max);
  const ticks: NavigatorTick<R>[] = [];
  for (let i = 0; i < displayCount; i++) {
    const mappedIndex = total <= max ? i : Math.round((i / (displayCount - 1)) * (total - 1));
    ticks.push({ row: rows[mappedIndex], active: mappedIndex === activeIndex });
  }
  return ticks;
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

// A user message the sticky prompt may show: the human's own ask (not machine
// delivered, not a spawned briefing, not a bare nudge), with visible text
// that is not a system message.
export function isStickyEligible(content: string): boolean {
  if (stickyPromptContent(content) === null) return false;
  const display = cleanContent(content);
  return display.length > 0 && !isSystemMessage(display);
}

// Pick the latest user message that sits ABOVE the loaded window — the most
// recent prompt the reader scrolled past but that isn't paginated in yet.
// Returning the first not-loaded message instead would always surface the
// conversation's opening prompt when parked deep in a long thread.
export function pickStickyFallback(
  userMessages: StickySourceMessage[] | null | undefined,
  loadedIds: Set<string>,
  earliestLoadedTs: number,
): { id: string; content: string; fromUserId?: string } | null {
  if (!userMessages || userMessages.length === 0) return null;
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const msg = userMessages[i];
    if (msg.role !== "user") continue;
    if (loadedIds.has(msg._id) || !isStickyEligible(msg.content)) continue;
    if (msg.timestamp >= earliestLoadedTs) continue;
    return { id: msg._id, content: msg.content, fromUserId: msg.from_user_id };
  }
  return null;
}

// Same pick, but assembling the loaded-window inputs (id set + earliest
// timestamp) from the loaded messages themselves — both platforms hand their
// loaded list straight in instead of building the Set by hand.
export function pickStickyFallbackFromLoaded(
  userMessages: StickySourceMessage[] | null | undefined,
  loaded: { _id: string; timestamp?: number }[],
): { id: string; content: string; fromUserId?: string } | null {
  const loadedIds = new Set<string>();
  let earliestLoadedTs = Infinity;
  for (const m of loaded) {
    loadedIds.add(m._id);
    if (typeof m.timestamp === "number" && m.timestamp < earliestLoadedTs) earliestLoadedTs = m.timestamp;
  }
  return pickStickyFallback(userMessages, loadedIds, earliestLoadedTs);
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
