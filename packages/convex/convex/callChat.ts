// Text chat alongside a huddle. One thread per room: the call stage shows it
// live, and the call page shows the same thread next to the transcript, so
// links and asides dropped mid-call are there when the recording is read
// later. Authorization is the room's own membership rule (grants admit a
// guest to the running huddle, not to the room's history).
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { authorizeRoom } from "./callRooms";

const MAX_TEXT = 4000;
const PAGE = 200;

export const list = query({
  args: { room_key: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) return null;
    const rows = await ctx.db
      .query("call_chat_messages")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .order("desc")
      .take(Math.min(args.limit ?? PAGE, PAGE));
    rows.reverse();
    const users = new Map<string, { name: string; image?: string }>();
    for (const r of rows) {
      const key = String(r.user_id);
      if (!users.has(key)) {
        const u = await ctx.db.get(r.user_id);
        users.set(key, { name: u?.name ?? u?.email ?? "someone", image: u?.image ?? undefined });
      }
    }
    return rows.map((r) => {
      const u = users.get(String(r.user_id))!;
      return {
        _id: r._id,
        user_id: String(r.user_id),
        user_name: u.name,
        user_image: u.image,
        text: r.text,
        at: r._creationTime,
        mine: String(r.user_id) === String(userId),
      };
    });
  },
});

export const post = mutation({
  args: { room_key: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // authorizeRoom (grant included): an invited guest in the live huddle can
    // talk in its chat, same as they can speak in its audio.
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot chat in this room: ${auth.reason}`);
    const text = args.text.trim().slice(0, MAX_TEXT);
    if (!text) return;
    await ctx.db.insert("call_chat_messages", {
      room_key: args.room_key,
      team_id: auth.teamId,
      user_id: userId,
      text,
    });
  },
});
