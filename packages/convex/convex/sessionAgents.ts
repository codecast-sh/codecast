// The agents working for a session: the workers nested under it
// (parent_conversation_id). A session it only spawned (a plain `cast spawn`, an
// agent-team teammate) is its peer, not its worker, and is not listed. Under
// the owners model (team feature session_owners) a worker is owned by the
// session it is nested under, not by a person, so it stays out of every inbox;
// the conversation's agents band lists it from here, with its state and the
// people who own it, so a person can add themselves to one.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { checkConversationAccess, conversationAccessMemo } from "./privacy";
import { ownersModelOnMemo } from "./lib/inboxOwners";
import { sessionOwnerFactsOf } from "./sessionOwners";
import { ownersOf } from "@codecast/shared/contracts/sessionOwners";
import { isRunLog } from "@codecast/shared/contracts";

/** Children read per link; a session with more agents than this lists its newest. */
export const SESSION_AGENTS_CAP = 50;

export type SessionAgent = {
  _id: Id<"conversations">;
  short_id: string;
  title: string | null;
  /** The daemon's raw status (managed_sessions.agent_status), null when none. */
  agent_status: string | null;
  updated_at: number;
  message_count: number;
  /** The session still owns it (not released to a person). */
  owned_by_parent: boolean;
  /** Its person owners, the implicit starter included. Empty off the model. */
  owners: Array<{ _id: string; name: string | null; image: string | null }>;
};

export async function performListSessionAgents(ctx: { db: any }, viewerId: Id<"users">, conversationId: Id<"conversations">): Promise<SessionAgent[] | null> {
  const parent = await ctx.db.get(conversationId);
  if (!parent || (await checkConversationAccess(ctx as any, viewerId, parent)) === "denied") return null;
  const nested = await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conversationId)).order("desc").take(SESSION_AGENTS_CAP);
  const byId = new Map<string, any>();
  for (const c of nested) {
    if (c.inbox_killed_at || isRunLog(c) || c.parent_message_uuid === "plan-handoff") continue;
    byId.set(String(c._id), c);
  }
  // Each child is checked on its own: access to the parent grants nothing on a private child.
  const canRead = conversationAccessMemo(ctx as any, viewerId);
  const readable = await Promise.all([...byId.values()].map(async (c) => ((await canRead(c)) ? c : null)));
  const children = readable.filter((c): c is any => c !== null).sort((a, b) => b.updated_at - a.updated_at).slice(0, SESSION_AGENTS_CAP);
  const users = new Map<string, Promise<any>>();
  const userOf = (id: string) => {
    let hit = users.get(id);
    if (!hit) users.set(id, (hit = Promise.resolve(ctx.db.get(id as Id<"users">)).catch(() => null)));
    return hit;
  };
  return Promise.all(children.map(async (c): Promise<SessionAgent> => {
    const [model, managed] = await Promise.all([
      ownersModelOnMemo(ctx, c),
      ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", c._id)).first(),
    ]);
    // Its owners by the shared rule over its rows, read once: the people, the
    // implicit starter and whether its parent still owns it.
    const resolved = model ? ownersOf(await sessionOwnerFactsOf(ctx, c)) : null;
    const ids = resolved ? [...resolved.people, ...(resolved.implicitStarter ? [resolved.implicitStarter] : [])] : [];
    const people = await Promise.all(ids.map(async (id) => {
      const u = await userOf(id);
      return { _id: id, name: u?.name ?? u?.email ?? null, image: u?.image ?? null };
    }));
    return {
      _id: c._id,
      short_id: c.short_id ?? String(c._id).slice(0, 7),
      title: c.title ?? null,
      agent_status: managed?.agent_status ?? null,
      updated_at: c.updated_at,
      message_count: c.message_count ?? 0,
      owned_by_parent: resolved ? String(resolved.parentSession) === String(conversationId) : !c.parent_released_at,
      owners: people,
    };
  }));
}

export const listSessionAgents = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return performListSessionAgents(ctx, userId, args.conversation_id);
  },
});
