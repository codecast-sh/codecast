import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isRoomlessKey } from "@codecast/shared/contracts";
import { mutation } from "./functions";

/** The scribe hands its seat back: the run stays live and the next client to
 *  ask (`start`) takes it, as after a Record press. The phone scribes only its
 *  own mic, so it releases when someone else sits down, and a web or desktop
 *  seat that hears every track picks the run up. Only the current scribe may;
 *  for anyone else it is a no-op. */
export const releaseScribe = mutation({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (isRoomlessKey(args.room_key)) return { released: false };
    const live = (
      await ctx.db
        .query("transcripts")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect()
    ).find((t) => t.status === "live");
    // Anyone but the scribe gets the same answer as a room with no call, so
    // a guessable key (dm:<id>) never tells a stranger a call is running.
    if (!live || live.scribe_open || String(live.started_by) !== String(userId)) return { released: false };
    await ctx.db.patch(live._id, { scribe_open: true });
    return { released: true };
  },
});
