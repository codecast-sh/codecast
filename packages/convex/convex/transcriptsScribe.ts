// The call's Scribe: the one agent a call may have, which listens and keeps
// its board. inviteScribe claims the call's slot; the claimer spawns the agent
// and seats it with transcripts.addRoute (role "scribe", the claim's id);
// removeScribe shows it out. The claim lives on the transcript (scribe_claim).
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isRoomlessKey } from "@codecast/shared/contracts";
import { scribeStatus, SCRIBE_CLAIM_TTL_MS } from "@codecast/shared/contracts/scribePrompt";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { authorizeRoom } from "./callRooms";
import { liveTranscriptFor } from "./callChat";
import { syncAgentFeeds } from "./transcripts";

/** Claim the call's one Scribe slot. Serializable, so two people inviting at
 *  once (both with "always invite Scribe" on) yield one claim: the second
 *  reads the first's and is told Scribe is already joining. Only the claimer
 *  spawns the agent, then seats it with addRoute (role "scribe", this claim).
 *  A claim whose agent never lands stops holding the slot after
 *  SCRIBE_CLAIM_TTL_MS (scribeStatus), so a crashed spawn blocks nobody. */
export const inviteScribe = mutation({
  // `auto`: the person's "Invite Scribe to every huddle", not a press. It is
  // refused once somebody removed Scribe from this call; a person's own
  // invite brings Scribe back and clears the removal.
  args: { room_key: v.string(), auto: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { claimed: true; claim_id: number; transcript_id: Id<"transcripts"> }
    | { claimed: false; existing: "joining" | "listening" | "removed" }
  > => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await liveScribeTranscript(ctx, userId, args.room_key);
    if (!t) throw new Error("The huddle is not being transcribed, so Scribe would hear nothing");
    const now = Date.now();
    // The claimer asking again (a lost answer retried, an outbox replay) gets
    // its own claim back, so its flow carries on rather than read "taken".
    const mine = t.scribe_claim;
    if (mine && !mine.removed && String(mine.by) === String(userId) && now - mine.at < SCRIBE_CLAIM_TTL_MS) {
      return { claimed: true, claim_id: mine.at, transcript_id: t._id };
    }
    const existing = scribeStatus(t, now);
    if (existing !== "absent") return { claimed: false, existing };
    if (args.auto && t.scribe_claim?.removed) return { claimed: false, existing: "removed" };
    await ctx.db.patch(t._id, { scribe_claim: { by: userId, at: now } });
    return { claimed: true, claim_id: now, transcript_id: t._id };
  },
});

/** Anyone in the call shows Scribe out: its route goes, and the claim
 *  records the removal, so automatic invites stay out for the rest of the
 *  call. With `claim`, the inviter is only giving back a claim whose agent
 *  failed to start, which leaves alone a Scribe somebody else has since
 *  invited. */
export const removeScribe = mutation({
  args: { room_key: v.string(), claim: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await liveScribeTranscript(ctx, userId, args.room_key);
    if (!t) return;
    if (args.claim !== undefined) {
      if (!t.scribe_claim?.removed && t.scribe_claim?.at === args.claim && String(t.scribe_claim.by) === String(userId)) {
        await ctx.db.patch(t._id, { scribe_claim: undefined });
      }
      return;
    }
    await ctx.db.patch(t._id, { routes: t.routes.filter((r) => r.role !== "scribe"), scribe_claim: { by: userId, at: Date.now(), removed: true } });
    await syncAgentFeeds(ctx, (await ctx.db.get(t._id))!);
  },
});

/** The live transcript of a room the caller is in, by addRoute's rule: the
 *  room's own authorization, and a recording's owner alone. Throws for a
 *  caller outside the room; null when nothing is being transcribed. */
async function liveScribeTranscript(ctx: any, userId: Id<"users">, roomKey: string): Promise<Doc<"transcripts"> | null> {
  if (!(await authorizeRoom(ctx, userId, roomKey, { rec: true })).ok) throw new Error("Not in this huddle");
  const t = await liveTranscriptFor(ctx, roomKey);
  if (t && isRoomlessKey(roomKey) && String(t.started_by) !== String(userId)) throw new Error("Not in this huddle");
  return t;
}
