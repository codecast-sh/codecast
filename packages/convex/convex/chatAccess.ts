// The ONE access rule for chat rooms, shared by chat.ts (reading, writing,
// notifying) and callRooms.ts (huddling in a channel's room): a public channel
// is readable and writable by the members of its team; a private channel or
// DM additionally requires a membership row — the team check stays underneath
// so leaving the team closes every door at once, even if a membership row
// lingers. A community channel (the public site's rooms) is open to every
// signed-in user, and canReadChannelAnonymously opens it to visitors too.
// `team_id` stays ROUTING on every kind — access never reads it alone.
// Returns false rather than throwing so queries can degrade to an empty
// result.
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { isConversationOwner, isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { roleWorkedFor } from "./lib/actor";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Private channels and DMs gate on their member rows; public gates on the team. */
export function isRestricted(channel: Doc<"chat_channels">): boolean {
  return channel.kind === "private" || channel.kind === "dm";
}

/** The product's public rooms: every visitor reads, every signed-in user
 *  writes. The routing team is where they are managed, not who may enter. */
export function isCommunity(channel: Doc<"chat_channels"> | null | undefined): boolean {
  return channel?.kind === "community";
}

/**
 * May someone with NO identity read this room? Only a community channel, and
 * only while it is open — an archived room leaves the public site with the
 * rail. The one place chat answers a question for an anonymous caller;
 * every write still needs a signed-in user.
 */
export function canReadChannelAnonymously(channel: Doc<"chat_channels"> | null): boolean {
  return !!channel && isCommunity(channel) && !channel.archived_at;
}

// Every kind but "dm", plus absent (a pre-kind public room). Keyed by kind so a
// new kind fails the typecheck here until someone says which side it is on.
const ROOM_KIND: Record<Exclude<NonNullable<Doc<"chat_channels">["kind"]>, "dm">, true> = {
  public: true, private: true, agents: true, community: true,
};
const ROOM_KINDS = [undefined, ...Object.keys(ROOM_KIND)];
const byName = (a: Doc<"chat_channels">, b: Doc<"chat_channels">) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * A team's named rooms, in name order, up to `limit`. Never a DM: a DM's name
 * is "", so a read by name alone lists every DM first, and in a team with
 * hundreds of them any cap filled with DMs and dropped the rooms late in the
 * alphabet (#team, Nov 2026). The cap on named rooms (createChannel) counts
 * these; a DM is reached through its members (teamRoomsAndDms).
 */
export async function teamRooms(ctx: ReadCtx, teamId: Id<"teams">, limit: number): Promise<Doc<"chat_channels">[]> {
  const perKind = await Promise.all(ROOM_KINDS.map((kind) => ctx.db
    .query("chat_channels")
    .withIndex("by_team_kind_name", (q: any) => q.eq("team_id", teamId).eq("kind", kind))
    .take(limit)));
  return perKind.flat().sort(byName).slice(0, limit);
}

// How many of a person's newest room memberships are opened to find their DMs.
// Membership rows are small and read whole; opening each room is what grows.
const DM_MEMBERSHIPS_OPENED = 500;

/** Every chat_channel_members row of a person, oldest first (by_user). */
export function roomMemberships(ctx: ReadCtx, userId: Id<"users">): Promise<Doc<"chat_channel_members">[]> {
  return ctx.db.query("chat_channel_members").withIndex("by_user", (q: any) => q.eq("user_id", userId)).collect();
}

/**
 * The rooms a person's rail draws from in one team: its named rooms, plus the
 * person's own DMs there, read from their member rows (pass `rows` when one
 * call covers several teams). `memberOf` is every restricted room they are
 * inside. Access is still the caller's to apply.
 */
export async function teamRoomsAndDms(
  ctx: ReadCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
  limit: number,
  rows?: Doc<"chat_channel_members">[],
): Promise<{ channels: Doc<"chat_channels">[]; memberOf: Set<string> }> {
  rows ??= await roomMemberships(ctx, userId);
  const memberOf = new Set(rows.map((r) => r.channel_id.toString()));
  // Reads stay bounded however many DMs a person has ever been in: only their
  // newest memberships are opened, and past `limit` only the DMs with the
  // newest lines reach railFor, which reads deep into each. A channel row is
  // not stamped per line, hence the read per DM.
  const opened = [...new Set(rows.slice(-DM_MEMBERSHIPS_OPENED).map((r) => r.channel_id.toString()))];
  let dms = (await Promise.all(opened.map((id) => ctx.db.get(id as Id<"chat_channels">))))
    .filter((c): c is Doc<"chat_channels"> => !!c && c.kind === "dm" && c.team_id.toString() === teamId.toString());
  if (dms.length > limit) {
    const newest = new Map(await Promise.all(dms.map(async (c) => [c._id.toString(), (await ctx.db
      .query("chat_messages")
      .withIndex("by_channel_created", (q: any) => q.eq("channel_id", c._id))
      .order("desc")
      .first())?.created_at ?? c.created_at] as const)));
    dms = dms.sort((a, b) => newest.get(b._id.toString())! - newest.get(a._id.toString())!).slice(0, limit);
  }
  const channels = [...(await teamRooms(ctx, teamId, limit)), ...dms].sort(byName);
  return { channels, memberOf };
}

export async function isChannelMember(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
): Promise<boolean> {
  const row = await ctx.db
    .query("chat_channel_members")
    .withIndex("by_channel_user", (q: any) =>
      q.eq("channel_id", channelId).eq("user_id", userId))
    .first();
  return !!row;
}

export async function channelMemberIds(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
): Promise<Id<"users">[]> {
  const rows = await ctx.db
    .query("chat_channel_members")
    .withIndex("by_channel", (q: any) => q.eq("channel_id", channelId))
    .collect();
  return rows.map((r) => r.user_id);
}

/** The most roles and sessions one room holds (agent-channels.md C5). */
export const MAX_CHANNEL_AGENTS = 50;

/** The roles and sessions inside a room: chat_channel_agents rows. */
export async function channelAgentRows(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
): Promise<Doc<"chat_channel_agents">[]> {
  return await ctx.db
    .query("chat_channel_agents")
    .withIndex("by_channel", (q: any) => q.eq("channel_id", channelId))
    .take(MAX_CHANNEL_AGENTS);
}

export async function canAccessChannel(
  ctx: ReadCtx,
  userId: Id<"users">,
  channel: Doc<"chat_channels"> | null,
): Promise<boolean> {
  if (!channel) return false;
  // A community room is open to every signed-in user: no team membership, no
  // per-team feature flag. Who may MANAGE it is a separate question the
  // mutations ask of the routing team's admins.
  if (isCommunity(channel)) return true;
  if (!(await isTeamMember(ctx as any, userId, channel.team_id))) return false;
  // Chat is a per-team opt-in: a team that turned it off (or never turned it
  // on) has no readable channels, member or not.
  if (!(await teamHasFeature(ctx as any, channel.team_id, "chat"))) return false;
  if (isRestricted(channel)) {
    if (await isChannelMember(ctx, channel._id, userId)) return true;
    // The anchor's host stands in for the anchor. An anchor is a MEMBER of the
    // DM rooms it opens or is messaged in, but the session that reads and
    // answers there authenticates as the human who hosts it — so that human
    // may enter those rooms too. Their machine runs the anchor and holds the
    // transcript, so this widens nothing they could not already see. Only DM
    // rooms: a private channel never has a bot member.
    if (channel.kind === "dm" && await hostsAnchorIn(ctx, channel._id, userId)) return true;
    // A role or session in a room (a member put it in a private room, or a
    // session's own DM with people) reads and answers there as the person who
    // runs it, the same stand-in an anchor's host is for its DM rooms: the
    // lines reach that person's machine anyway.
    return await runsAgentIn(ctx, channel._id, userId);
  }
  return true;
}

// Does `userId` run one of the room's member agents: own the session, or host
// (or personally own) the role's standing agent?
async function runsAgentIn(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
): Promise<boolean> {
  for (const row of await channelAgentRows(ctx, channelId)) {
    if (row.conversation_id) {
      const conversation = await ctx.db.get(row.conversation_id);
      if (conversation && (await isConversationOwner(ctx as any, userId, conversation as any))) return true;
    } else if (row.role_id) {
      const role = await ctx.db.get(row.role_id);
      if (role && isRunner(role, userId)) return true;
    }
  }
  return false;
}

// The host or personal owner of an anchor, or of a role (whose standing
// session runs on its host's machine): both rows carry the same two fields.
function isRunner(row: Pick<Doc<"anchors">, "host_user_id" | "scope_user_id">, userId: Id<"users">): boolean {
  return row.host_user_id.toString() === userId.toString()
    || (!!row.scope_user_id && row.scope_user_id.toString() === userId.toString());
}

// Is `userId` the host (or personal owner) of an anchor whose bot identity is a
// member of this room?
async function hostsAnchorIn(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
): Promise<boolean> {
  for (const memberId of await channelMemberIds(ctx, channelId)) {
    const member = await ctx.db.get(memberId);
    if (!member?.is_bot) continue;
    const anchor = await ctx.db
      .query("anchors")
      .withIndex("by_bot_user", (q: any) => q.eq("bot_user_id", memberId))
      .first();
    if (anchor && isRunner(anchor, userId)) return true;
  }
  return false;
}

// ── A session reading as its person ─────────────────────────────────────────
//
// A session runs `cast chat` with its person's token, so canAccessChannel
// alone would hand every session on a laptop every DM its person is in. A
// read the CLI stamps as a session's (origin "agent", the stamp a send
// carries) reads a DM only when the session is part of it:
//
// - its anchor or role's bot is a member of the room (the workspace agent's
//   and a role's DMs, which they answer through cast chat reply);
// - it is one of the room's agents (chat_channel_agents: a session's own DM
//   with people, or a room a role it works for was put in);
// - chat brought it into the room (chat_session_rooms, written by
//   grantSessionRoom): a person @mentioned it there, or the server delivered
//   one of the room's lines into it (a person's mention, a hand-off). A reply
//   relayed into the session that started a thread opens that thread only,
//   so a session that posts into a DM and gets an answer reads the answer,
//   not the history. A line or a mention a session posted itself opens
//   nothing.
//
// This is a guardrail against reading by accident, not a boundary against a
// hostile process: the stamp is the caller's own word, as on sends, and a
// process holding the token can leave it off. Public, agents and private
// channels stay on canAccessChannel: a person put their sessions' work there.

/** The stamp `cast chat` reads carry when they run inside a session. */
export const chatReadOriginArgs = {
  origin: v.optional(v.literal("agent")),
  origin_session_id: v.optional(v.string()),
};

export type ChatReadOrigin = { origin?: "agent"; origin_session_id?: string };

export type SessionChatScope = {
  /** The session's short id, what a person types to @mention it. */
  label: string;
  conversation: Doc<"conversations"> | null;
  /** The role whose seat this session holds: role grants and role room rows apply only to it. */
  role: Doc<"org_roles"> | null;
  botIds: string[];
  /** Verdicts already reached this request, by channel id. */
  verdicts: Map<string, boolean>;
  /** Every DM the session was granted or put in, built once for a listing. */
  listed?: Set<string>;
};

// A room's newest rows read when no grant answers: a person's @mention of the
// session there from before grants were written.
const SCOPE_ROOM_SCAN = 300;
const SCOPE_LIST_CAP = 500;
const SCOPE_LIST_AGENT_ROWS = 500;

/** Who is asking, or null when the read is not a session's. Cheap: the
 *  rooms are looked up per room (sessionMayReadChannel), never up front. */
export async function sessionChatScope(
  ctx: ReadCtx,
  userId: Id<"users">,
  origin: ChatReadOrigin,
): Promise<SessionChatScope | null> {
  if (origin.origin !== "agent") return null;
  const ref = (origin.origin_session_id ?? "").trim();
  const conversation: Doc<"conversations"> | null = ref
    ? await findConversationByAnyRefWhere(ctx, ref, (c) => isConversationOwner(ctx as any, userId, c))
    : null;
  // Who speaks as the role in its bot's DMs (chat.ts sessionVoice: the
  // standing session, a hand, a station of the role's run) reads them too.
  // Grants and room rows written for the role open only to its seat.
  const role = conversation ? await roleWorkedFor(ctx as any, conversation) : null;
  const seatRole = role && conversation?.standing_role_id && String(conversation.standing_role_id) === String(role._id) ? role : null;
  // A role's hand speaks as the role in the DMs its bot is in (chat.ts
  // sessionVoice), so it reads them too. The anchor's own session and a
  // role's standing session count only while the anchor still points at
  // them: an earlier session of a reseated anchor keeps the pointer, not the
  // seat.
  const botIds: string[] = [];
  for (const anchorId of [conversation?.anchor_id, role?.anchor_id]) {
    const anchor = anchorId ? await ctx.db.get(anchorId) : null;
    if (!anchor?.bot_user_id || anchor.status === "decommissioned") continue;
    const seatOnly = anchorId === conversation?.anchor_id || !!conversation?.standing_role_id;
    if (seatOnly && anchor.conversation_id && String(anchor.conversation_id) !== String(conversation!._id)) continue;
    botIds.push(String(anchor.bot_user_id));
  }
  return {
    label: conversation ? conversation.short_id ?? String(conversation._id).slice(0, 7) : "",
    conversation,
    role: seatRole,
    botIds,
    verdicts: new Map(),
  };
}

/** A person's line, not a session's or an agent's: only such a mention lets a session in. */
const personAuthored = (row: Doc<"chat_messages">) => row.origin !== "agent" && row.author_kind !== "agent";

const mentionsScope = (row: Doc<"chat_messages">, conversationId: string, roleId: string | null) =>
  (row.mentions ?? []).some((m: any) => typeof m === "object"
    && ((m?.kind === "session" && String(m.conversation_id) === conversationId) || (!!roleId && m?.kind === "role" && String(m.role_id) === roleId)));

/**
 * May the session behind `scope` read this room? Always, when it is not a DM.
 * Cheapest evidence first. `deep` adds a scan of the room's newest rows, for
 * a session that joined before grants were written: what a single-room read
 * affords and a listing of every room does not.
 */
export async function sessionMayReadChannel(
  ctx: ReadCtx,
  scope: SessionChatScope | null,
  channel: Doc<"chat_channels">,
  opts: { deep?: boolean; thread?: Id<"chat_messages"> } = {},
): Promise<boolean> {
  if (!scope || channel.kind !== "dm") return true;
  const key = String(channel._id);
  const known = scope.verdicts.get(key);
  if (known === undefined || (!known && opts.deep)) {
    scope.verdicts.set(key, await decide(ctx, scope, channel, !!opts.deep));
  }
  if (scope.verdicts.get(key)) return true;
  // A thread read also passes on that thread's own grant.
  return !!opts.thread && await threadGranted(ctx, scope, channel, opts.thread);
}

async function threadGranted(ctx: ReadCtx, scope: SessionChatScope, channel: Doc<"chat_channels">, thread: Id<"chat_messages">): Promise<boolean> {
  if (!scope.conversation) return false;
  const byConversation = await ctx.db.query("chat_session_rooms")
    .withIndex("by_conversation_channel", (q: any) => q.eq("conversation_id", scope.conversation!._id).eq("channel_id", channel._id).eq("thread_root_id", thread))
    .first();
  if (byConversation) return true;
  return !!scope.role && !!(await ctx.db.query("chat_session_rooms")
    .withIndex("by_role_channel", (q: any) => q.eq("role_id", scope.role!._id).eq("channel_id", channel._id).eq("thread_root_id", thread))
    .first());
}

async function decide(ctx: ReadCtx, scope: SessionChatScope, channel: Doc<"chat_channels">, deep: boolean): Promise<boolean> {
  const conversation = scope.conversation;
  if (!conversation) return false;
  if (scope.listed) return scope.listed.has(String(channel._id)) || (deep && await roomScan(ctx, scope, channel));
  for (const botId of scope.botIds) {
    if (await isChannelMember(ctx, channel._id, botId as Id<"users">)) return true;
  }
  for (const row of await channelAgentRows(ctx, channel._id)) {
    if (row.conversation_id && String(row.conversation_id) === String(conversation._id)) return true;
    if (row.role_id && scope.role && String(row.role_id) === String(scope.role._id)) return true;
  }
  // Room grants only: a thread's grant opens that thread (threadGranted).
  const granted = await ctx.db.query("chat_session_rooms")
    .withIndex("by_conversation_channel", (q: any) => q.eq("conversation_id", conversation._id).eq("channel_id", channel._id).eq("thread_root_id", undefined))
    .first();
  if (granted) return true;
  if (scope.role) {
    const roleGrant = await ctx.db.query("chat_session_rooms")
      .withIndex("by_role_channel", (q: any) => q.eq("role_id", scope.role!._id).eq("channel_id", channel._id).eq("thread_root_id", undefined))
      .first();
    if (roleGrant) return true;
  }
  return deep && await roomScan(ctx, scope, channel);
}

async function roomScan(ctx: ReadCtx, scope: SessionChatScope, channel: Doc<"chat_channels">): Promise<boolean> {
  const conversationId = String(scope.conversation!._id);
  const roleId = scope.role ? String(scope.role._id) : null;
  const rows = await ctx.db.query("chat_messages")
    .withIndex("by_channel_created", (q: any) => q.eq("channel_id", channel._id))
    .order("desc").take(SCOPE_ROOM_SCAN);
  return rows.some((row) => personAuthored(row) && mentionsScope(row, conversationId, roleId));
}

/**
 * Prepare `scope` to judge many rooms at once (a channel listing, a search):
 * one read per kind of evidence instead of several per room. Rooms reached
 * only through the room scan are left out of listings; a single-room read
 * still finds them.
 */
export async function primeSessionListing(ctx: ReadCtx, scope: SessionChatScope | null, dmIds: Id<"chat_channels">[]): Promise<void> {
  if (!scope?.conversation || scope.listed || dmIds.length === 0) return;
  const listed = new Set<string>();
  const take = async (index: "by_conversation_channel" | "by_role_channel", field: "conversation_id" | "role_id", value: any) => {
    for (const row of await ctx.db.query("chat_session_rooms").withIndex(index, (q: any) => q.eq(field, value)).take(SCOPE_LIST_CAP)) {
      if (!row.thread_root_id) listed.add(String(row.channel_id));
    }
  };
  await take("by_conversation_channel", "conversation_id", scope.conversation._id);
  for (const row of await ctx.db.query("chat_channel_agents").withIndex("by_conversation", (q: any) => q.eq("conversation_id", scope.conversation!._id)).take(SCOPE_LIST_AGENT_ROWS)) listed.add(String(row.channel_id));
  if (scope.role) {
    await take("by_role_channel", "role_id", scope.role._id);
    for (const row of await ctx.db.query("chat_channel_agents").withIndex("by_role", (q: any) => q.eq("role_id", scope.role!._id)).take(SCOPE_LIST_AGENT_ROWS)) listed.add(String(row.channel_id));
  }
  for (const id of dmIds) {
    if (listed.has(String(id))) continue;
    for (const botId of scope.botIds) {
      if (await isChannelMember(ctx, id, botId as Id<"users">)) { listed.add(String(id)); break; }
    }
  }
  scope.listed = listed;
}

/**
 * Record that chat brought a session (or a role) into a DM. Idempotent; a
 * no-op for any other kind of room. Called where the server delivers a DM's
 * line into a session (openSessionReply) and where a person's @mention of a
 * session folds instead of waking it.
 */
export async function grantSessionRoom(
  ctx: Pick<MutationCtx, "db">,
  channel: Pick<Doc<"chat_channels">, "_id" | "kind">,
  who: { conversation_id?: Id<"conversations">; role_id?: Id<"org_roles"> },
  via: "wake" | "mention" | "relay" | "backfill",
  thread?: Id<"chat_messages">,
): Promise<boolean> {
  if (channel.kind !== "dm" || (!who.conversation_id && !who.role_id)) return false;
  const at = (q: any) => q.eq("channel_id", channel._id).eq("thread_root_id", thread);
  const existing = who.role_id
    ? await ctx.db.query("chat_session_rooms").withIndex("by_role_channel", (q: any) => at(q.eq("role_id", who.role_id))).first()
    : await ctx.db.query("chat_session_rooms").withIndex("by_conversation_channel", (q: any) => at(q.eq("conversation_id", who.conversation_id))).first();
  if (existing) return false;
  await ctx.db.insert("chat_session_rooms", {
    channel_id: channel._id,
    ...(who.role_id ? { role_id: who.role_id } : { conversation_id: who.conversation_id }),
    ...(thread ? { thread_root_id: thread } : {}),
    via,
    created_at: Date.now(),
  });
  return true;
}

/** Whom a wake into `conversation` grants: a role's standing session stands
 *  for its role, so the role's next seat and its hands keep the room. */
export function grantTargetOf(conversation: Pick<Doc<"conversations">, "_id" | "standing_role_id">): { conversation_id?: Id<"conversations">; role_id?: Id<"org_roles"> } {
  return conversation.standing_role_id ? { role_id: conversation.standing_role_id } : { conversation_id: conversation._id };
}

/** Keep a name safe inside a double-quoted shell argument the agent copies. */
const quotedName = (name: string) => name.replace(/[$`"\\!]/g, "").trim() || "someone";

/** What a session hears when it asks for a DM it is not part of: why, and
 *  the two ways its person lets it in (a mention there, or a Yes on a card
 *  that runs the read as theirs; personEnv drops the session stamp). */
export function sessionDmRefusal(
  scope: SessionChatScope,
  opts: { withNames: string[]; readCommand: string; personInRoom: boolean },
): string {
  const people = opts.withNames.length ? opts.withNames.map(quotedName).join(", ") : "someone";
  const room = opts.personInRoom ? `your person's direct message with ${people}` : `a direct message with ${people}`;
  const ask = `cast decide "<why you need it>. Let this session read ${opts.personInRoom ? "your" : "the"} direct message with ${people}? The lines go into its transcript." --run "${opts.readCommand}"`;
  const how = `To read it, ask: ${ask} (Yes runs that one read as your person and its output comes back to you).`;
  if (!scope.conversation) {
    return `That is ${room}. A session reads only the direct messages it is part of, and codecast cannot match this session to one of yours. ${how}`;
  }
  return `That is ${room}, and session ${scope.label} is not part of it: a session reads a direct message only when it was started from it or a person @mentioned it there. ${how}`;
}
