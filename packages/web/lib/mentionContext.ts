import type { MentionItem } from "./mentionItem";
import { mentionUserIds } from "@codecast/shared/chat";
import { parseChatDraftKey } from "./chatDraftKey";

// What the conversation the reader is typing into already talks about.
//
// The @ popup's best guess at "who or what do you mean" is whatever this
// session or chat thread has named so far: the people in it, the tasks and
// sessions it cites, the channels it points at. Those lead the list, most
// recently mentioned first, ahead of the global recency order.
//
// Built from plain text plus the ids of the people speaking, so every surface
// feeds it the same way: a session hands its message bodies, a chat thread its
// lines and their authors.

export type MentionContext = {
  /** Word-ish tokens (short ids, full ids, `doc:<id>`), lowercase, → position
   *  of their latest occurrence. */
  tokens: Map<string, number>;
  /** `@handle` tokens, lowercase, without the @. */
  handles: Map<string, number>;
  /** `#channel` tokens, lowercase, without the #. */
  channels: Map<string, number>;
  /** User ids of the people speaking here. */
  people: Map<string, number>;
};

export const EMPTY_MENTION_CONTEXT: MentionContext = {
  tokens: new Map(), handles: new Map(), channels: new Map(), people: new Map(),
};

const TOKEN_RE = /[a-z0-9][a-z0-9_:-]*/g;
const HANDLE_RE = /(?:^|[^\w/])@([a-z0-9][a-z0-9_-]{0,38})/g;
const CHANNEL_RE = /(?:^|[\s(])#([a-z0-9][a-z0-9_-]*)/g;

/** Texts oldest first; a later mention outranks an earlier one. */
export function buildMentionContext(texts: Array<string | null | undefined>, authorIds: Array<string | null | undefined> = []): MentionContext {
  const ctx: MentionContext = { tokens: new Map(), handles: new Map(), channels: new Map(), people: new Map() };
  let pos = 0;
  for (const raw of texts) {
    pos++;
    if (!raw) continue;
    const text = raw.length > 20_000 ? raw.slice(-20_000) : raw;
    const lower = text.toLowerCase();
    for (const m of lower.matchAll(TOKEN_RE)) ctx.tokens.set(m[0], pos);
    for (const m of lower.matchAll(HANDLE_RE)) ctx.handles.set(m[1], pos);
    for (const m of lower.matchAll(CHANNEL_RE)) ctx.channels.set(m[1], pos);
  }
  authorIds.forEach((id, i) => { if (id) ctx.people.set(String(id), i + 1); });
  return ctx;
}

/** How recently this conversation named the item (higher = later), or 0. */
export function mentionContextPosition(item: MentionItem, ctx: MentionContext | undefined): number {
  if (!ctx) return 0;
  const id = item.id.toLowerCase();
  switch (item.type) {
    case "person":
    case "role":
      return Math.max(
        ctx.people.get(item.id) ?? 0,
        item.handle ? ctx.handles.get(item.handle.toLowerCase()) ?? 0 : 0,
      );
    case "channel":
      return ctx.channels.get(item.label.toLowerCase()) ?? 0;
    case "doc":
      return Math.max(ctx.tokens.get(`doc:${id}`) ?? 0, ctx.tokens.get(id) ?? 0);
    case "file":
      return 0;
    default:
      return Math.max(
        item.shortId ? ctx.tokens.get(item.shortId.toLowerCase()) ?? 0 : 0,
        ctx.tokens.get(id) ?? 0,
      );
  }
}

type ContextState = {
  messages?: Record<string, ReadonlyArray<{ content?: unknown }>>;
  chatMessages?: Record<string, { _id: string; channel_id: string; thread_root_id?: string; content: string; user_id: string; created_at: number; mentions?: ReadonlyArray<unknown> }>;
};

const SESSION_WINDOW = 150;
const CHANNEL_WINDOW = 60;

/**
 * The context for whatever `conversationId` a composer is keyed by: a chat
 * draft key reads that thread (root and replies) or the channel's recent
 * lines; anything else reads the session's loaded messages.
 * A thread's speakers count as named; the viewer does not.
 */
export function mentionContextFor(state: ContextState, conversationId: string, viewerId?: string): MentionContext {
  const chat = parseChatDraftKey(conversationId);
  if (chat) {
    const lines = Object.values(state.chatMessages ?? {})
      .filter((m) => m.channel_id === chat.channelId && (chat.threadRootId
        ? m.thread_root_id === chat.threadRootId || m._id === chat.threadRootId
        : !m.thread_root_id))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-CHANNEL_WINDOW);
    // The viewer is never their own best guess.
    const people = lines.flatMap((m) => [...mentionUserIds(m.mentions as never), m.user_id]).filter((id) => id !== viewerId);
    return buildMentionContext(lines.map((m) => m.content), people);
  }
  const msgs = (state.messages?.[conversationId] ?? []).slice(-SESSION_WINDOW);
  return buildMentionContext(msgs.map((m) => (typeof m.content === "string" ? m.content : null)));
}
