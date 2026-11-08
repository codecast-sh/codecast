// Rounds: a room's agent members answering a line one at a time.
//
// The turn model is @codecast/shared/chat rounds.ts; this file does the IO.
// A person's line in a room with agent members (or an agent's new root there)
// opens a round on its thread. One member holds the floor and is handed the
// whole thread so far; when it answers there, ends its turn without answering
// (a pass), or sits on the floor too long, the next member gets the floor with
// everything said since. A member that is mid-turn when its turn comes goes to
// the end of the lap instead of having a stale line queued behind its work.
// Design and bounds: docs/architecture/agent-channels.md C6.

import { mutation, internalMutation } from "./functions";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  deferBusy,
  endRound as endRoundState,
  grantFloor,
  markUnreachable,
  memberForSession,
  mentionRoles,
  mentionSessions,
  nextCandidate,
  recordOutcome,
  restartRound,
  startRound,
  type ChatRound,
  type RoundMember,
  type RoundMemberSeed,
} from "@codecast/shared/chat";
import { enqueuePendingMessage, getAuthenticatedUserId, reachableRole } from "./pendingMessages";
import { canAccessChannel } from "./chatAccess";
import { patchChat } from "./lib/chatRows";
import { collectChatExcerpt } from "./chatExcerpt";
import { buildRoundWake } from "./chatWakePrompts";
import { agentActive, closeSessionReplyIn, openSessionReply, wakeIdUnread } from "./chatSessionReplies";
import { oneLine } from "./chatText";

/** How long a floor wake may sit unread (the session not picking it up) before the floor moves on. */
export const FLOOR_PICKUP_MS = 5 * 60_000;
/** How long a member may hold the floor after reading it. */
export const FLOOR_MAX_MS = 20 * 60_000;
/** How many of the thread's replies a floor wake quotes. */
const ROUND_THREAD_EXCERPT = 30;

/** Turns are for a room with several agents; a DM room or a room with one
 *  agent hands each person's line straight to it (chat.ts member rail). */
export function roomTakesTurns(channel: Doc<"chat_channels">, rows: Doc<"chat_channel_agents">[]): boolean {
  return channel.kind !== "dm" && rows.length >= 2;
}

const memberKey = (row: Doc<"chat_channel_agents">) => String(row.role_id ?? row.conversation_id);

async function seedsFor(ctx: MutationCtx, rows: Doc<"chat_channel_agents">[]): Promise<RoundMemberSeed[]> {
  const seeds: RoundMemberSeed[] = [];
  for (const row of rows) {
    if (row.role_id) {
      const role = await ctx.db.get(row.role_id);
      seeds.push({ key: memberKey(row), kind: "role", short_id: row.short_id, name: role ? `@${role.handle}` : row.short_id });
    } else if (row.conversation_id) {
      const conversation = await ctx.db.get(row.conversation_id);
      const title = conversation && !conversation.is_private && conversation.title ? oneLine(conversation.title, 60) : "";
      seeds.push({ key: memberKey(row), kind: "session", short_id: row.short_id, name: title || row.short_id });
    }
  }
  return seeds;
}

/** The member keys a line names, in the order it names them. Membership is
 *  the grant here: `@<short id>` of a member counts even when the writer could
 *  not mention that session elsewhere. */
function namedKeys(message: Doc<"chat_messages">, members: Array<{ key: string; short_id: string }>): string[] {
  const mentions = (message.mentions ?? []) as any;
  const resolved = [
    ...mentionSessions(mentions).map((m) => String(m.conversation_id)),
    ...mentionRoles(mentions).map((m) => String(m.role_id)),
  ];
  const typed = members
    .map((m) => ({ key: m.key, at: message.content.search(new RegExp(`@${m.short_id}\\b`)) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.key);
  return [...new Set([...typed, ...resolved])];
}

const label = (m: RoundMember) => (m.name && m.name !== m.short_id ? `${m.short_id} (${m.name})` : m.short_id);

export type RoundResult = { opened: boolean; floor: string | null; queued: number } | null;

/** The send path's hook: what a new line does to the round on its thread.
 *  Called for every line in a room that holds agent members. */
export async function onRoomLine(
  ctx: MutationCtx,
  opts: {
    channel: Doc<"chat_channels">;
    message: Doc<"chat_messages">;
    root: Doc<"chat_messages"> | null;
    rows: Doc<"chat_channel_agents">[];
    byPerson: boolean;
  },
): Promise<RoundResult> {
  if (opts.rows.length === 0) return null;
  const now = Date.now();
  const rootRow = opts.root ?? opts.message;
  const current = rootRow.round as ChatRound | undefined;
  const open = current?.status === "open" ? current : undefined;

  let round: ChatRound | null = null;
  let opened = false;
  if (opts.byPerson) {
    const seeds = await seedsFor(ctx, opts.rows);
    round = open
      ? restartRound(open, seeds, { named: namedKeys(opts.message, seeds), now })
      : startRound(seeds, { named: namedKeys(opts.message, seeds), byPerson: true, now });
    opened = !open;
  } else if (!opts.root) {
    // An agent's new root: the opener already said its piece.
    const seeds = await seedsFor(ctx, opts.rows);
    const opener = opts.message.origin_session_id
      ? seeds.find((s) => s.key === opts.message.origin_session_id)?.key
      : undefined;
    round = startRound(seeds, { named: namedKeys(opts.message, seeds), exclude: opener ? [opener] : [], byPerson: false, now });
    opened = true;
  } else if (open && opts.message.origin_session_id) {
    // An agent's reply in a thread with a round: its turn, if it is a member.
    const member = memberForSession(open, opts.message.origin_session_id);
    if (!member) return summary(open, false);
    round = recordOutcome(open, member.key, "spoke", { handTo: namedKeys(opts.message, open.members), now });
  } else {
    return open ? summary(open, false) : null;
  }
  // A person replying under a member's root is answering that member first.
  const starter = opts.byPerson && opts.root?.origin_session_id;
  if (starter && round.queue.includes(starter)) round = { ...round, queue: [starter, ...round.queue.filter((k) => k !== starter)] };
  round = await advance(ctx, opts.channel, rootRow._id, round);
  await patchChat(ctx, rootRow._id, { round });
  return summary(round, opened);
}

function summary(round: ChatRound, opened: boolean): RoundResult {
  const floor = round.members.find((m) => m.key === round.floor_key);
  return { opened, floor: floor?.short_id ?? null, queued: round.queue.length };
}

/** Hand the floor to the next member who can take it. Returns the new state;
 *  the caller writes it. */
async function advance(
  ctx: MutationCtx,
  channel: Doc<"chat_channels">,
  rootId: Id<"chat_messages">,
  start: ChatRound,
): Promise<ChatRound> {
  let round = start;
  // Every member is popped at most twice (once more after a busy deferral).
  for (let guard = 0; guard < round.members.length * 2 + 2; guard++) {
    const step = nextCandidate(round, Date.now());
    round = step.round;
    if (!step.key) return round;
    const member = round.members.find((m) => m.key === step.key);
    if (!member) continue;
    const conversation = await memberConversation(ctx, member);
    if (!conversation) {
      round = markUnreachable(round, member.key);
      continue;
    }
    if (!member.deferred && (await agentActive(ctx, conversation._id))) {
      round = deferBusy(round, member.key);
      continue;
    }
    const wakeId = await wakeMember(ctx, { channel, rootId, round, member, conversation });
    if (!wakeId) {
      round = markUnreachable(round, member.key);
      continue;
    }
    round = grantFloor(round, member.key, String(conversation._id), String(wakeId), Date.now());
    await openSessionReply(ctx, { channel, threadRootId: rootId, wakeId });
    await ctx.scheduler.runAfter(FLOOR_PICKUP_MS, internal.chatRounds.checkFloor, { root_id: rootId, wake_id: String(wakeId) });
    return round;
  }
  return round;
}

async function memberConversation(ctx: MutationCtx, member: RoundMember): Promise<Doc<"conversations"> | null> {
  if (member.kind === "role") {
    const id = ctx.db.normalizeId("org_roles", member.key);
    return id ? ((await reachableRole(ctx, id))?.standing ?? null) : null;
  }
  const id = ctx.db.normalizeId("conversations", member.key);
  return id ? await ctx.db.get(id) : null;
}

async function wakeMember(
  ctx: MutationCtx,
  opts: {
    channel: Doc<"chat_channels">;
    rootId: Id<"chat_messages">;
    round: ChatRound;
    member: RoundMember;
    conversation: Doc<"conversations">;
  },
): Promise<Id<"pending_messages"> | null> {
  const root = await ctx.db.get(opts.rootId);
  if (!root) return null;
  const sessionId = String(opts.conversation._id);
  const { entries, channelEntries } = await collectChatExcerpt(ctx, {
    channel: opts.channel,
    root,
    message: root,
    senderName: "",
    threadRootId: root._id,
    threadLimit: ROUND_THREAD_EXCERPT,
    isSelf: (row) => row.origin_session_id === sessionId,
  });
  const team = await ctx.db.get(opts.channel.team_id);
  const done = opts.round.members
    .filter((m) => m.key !== opts.member.key && ["spoke", "passed", "no_answer", "skipped"].includes(m.state))
    .map((m) => `${label(m)} ${m.state === "spoke" ? "answered" : m.state === "passed" ? "passed" : "was skipped"}`);
  const after = opts.round.queue
    .map((k) => opts.round.members.find((m) => m.key === k))
    .filter((m): m is RoundMember => !!m)
    .map(label);
  const where = `#${opts.channel.name}`;
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const body = buildRoundWake({
    channelName: opts.channel.name,
    channelKind: opts.channel.kind,
    channelTopic: opts.channel.topic,
    channelId: opts.channel._id,
    teamName: oneLine((team as any)?.name ?? "team", 60),
    threadRootId: root._id,
    entries,
    channelEntries,
    nonce,
    done,
    after,
  });
  try {
    return await enqueuePendingMessage(ctx, opts.conversation, root.user_id, {
      content: `<chat-mention channel="${where.replace(/"/g, "'")}" thread="${root._id}" from="round">\n${body}\n</chat-mention>`,
      // One wake per grant. Neither lap and turn numbers (a restarted lap reuses them) nor the
      // clock (two grants to one member can land in the same millisecond) tell grants apart.
      client_id: `chat-round:${root._id}:${opts.member.key}:${nonce}`,
      human: opts.round.by_person,
    });
  } catch {
    // A hosted session takes input from its owner only: it sits this round out.
    return null;
  }
}

async function moveOn(
  ctx: MutationCtx,
  root: Doc<"chat_messages">,
  round: ChatRound,
  outcome: "passed" | "no_answer" | "skipped",
): Promise<void> {
  const channel = await ctx.db.get(root.channel_id);
  if (!channel || !round.floor_key) return;
  if (round.floor_session_id) await closeSessionReplyIn(ctx, round.floor_session_id, channel._id, root._id);
  let next = recordOutcome(round, round.floor_key, outcome, { now: Date.now() });
  next = await advance(ctx, channel, root._id, next);
  await patchChat(ctx, root._id, { round: next });
}

/** A session's turn ended. If it held a floor and had read the wake, it
 *  passed: the floor moves on. Called beside closeSessionRepliesAfterTurn. */
export async function onRoundTurnEnded(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<void> {
  const roots = await ctx.db
    .query("chat_messages")
    .withIndex("by_round_floor_session", (q: any) => q.eq("round.floor_session_id", String(conversationId)))
    .take(10);
  for (const root of roots) {
    const round = root.round as ChatRound | undefined;
    if (round?.status !== "open" || round.floor_session_id !== String(conversationId) || !round.floor_wake_id) continue;
    const wakeId = ctx.db.normalizeId("pending_messages", round.floor_wake_id);
    if (wakeId && (await wakeIdUnread(ctx, wakeId))) continue;
    await moveOn(ctx, root, round, "passed");
  }
}

export const checkFloor = internalMutation({
  args: { root_id: v.id("chat_messages"), wake_id: v.string() },
  handler: async (ctx, args) => {
    const root = await ctx.db.get(args.root_id);
    const round = root?.round as ChatRound | undefined;
    if (!root || round?.status !== "open" || round.floor_wake_id !== args.wake_id) return;
    const now = Date.now();
    const since = round.floor_since ?? now;
    const wakeId = ctx.db.normalizeId("pending_messages", args.wake_id);
    const unread = wakeId ? await wakeIdUnread(ctx, wakeId) : false;
    const sessionId = round.floor_session_id ? ctx.db.normalizeId("conversations", round.floor_session_id) : null;
    if (unread) {
      if (now - since >= FLOOR_PICKUP_MS) return await moveOn(ctx, root, round, "no_answer");
    } else if (now - since >= FLOOR_MAX_MS) {
      return await moveOn(ctx, root, round, "no_answer");
    } else if (sessionId && !(await agentActive(ctx, sessionId))) {
      // Read it and is no longer working: the turn-end hook missed it.
      return await moveOn(ctx, root, round, "passed");
    }
    const wait = unread ? FLOOR_PICKUP_MS - (now - since) : Math.min(FLOOR_PICKUP_MS, FLOOR_MAX_MS - (now - since));
    await ctx.scheduler.runAfter(Math.max(wait, 30_000), internal.chatRounds.checkFloor, args);
  },
});

async function rootForPerson(ctx: MutationCtx, rootId: Id<"chat_messages">): Promise<{ root: Doc<"chat_messages">; round: ChatRound }> {
  const userId = await getAuthenticatedUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first" });
  const root = await ctx.db.get(rootId);
  const channel = root ? await ctx.db.get(root.channel_id) : null;
  if (!root || !channel || !(await canAccessChannel(ctx, userId, channel))) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That thread is gone" });
  }
  return { root, round: root.round as ChatRound };
}

/** A person moves the floor past the member holding it. */
export const skipFloor = mutation({
  args: { root_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const { root, round } = await rootForPerson(ctx, args.root_id);
    if (round?.status !== "open" || !round.floor_key) return null;
    await moveOn(ctx, root, round, "skipped");
    return null;
  },
});

/** A person ends the round: nobody else is woken for this thread. */
export const endRound = mutation({
  args: { root_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const { root, round } = await rootForPerson(ctx, args.root_id);
    if (round?.status !== "open") return null;
    if (round.floor_session_id) await closeSessionReplyIn(ctx, round.floor_session_id, root.channel_id, root._id);
    await patchChat(ctx, root._id, { round: endRoundState(round, Date.now()) });
    return null;
  },
});

