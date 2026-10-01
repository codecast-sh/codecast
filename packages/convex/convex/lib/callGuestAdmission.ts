// Ending a guest's admission, and making the media server agree.
//
// Every place a guest stops being allowed in a call (they walk out, somebody
// puts them out, their page goes quiet, the huddle ends) writes the row and
// then asks for a roster check through here, so "the row says out" and "the
// media server put them out" can never be two steps somebody forgets one of.
//
// WHY A CHECK AND NOT ONE EJECT. LiveKit has no token revocation, and it
// refreshes a connected participant's token by itself, so the token lifetime
// ends nothing. A single RemoveParticipant drops the connection once; a
// modified client, or the stock client reconnecting with the token it holds,
// walks straight back in. So the roster check (callGuests.enforceGuestRoster)
// lists who is really in the media room and removes every guest identity the
// rows do not allow right now, and it runs again on a tail of delays that
// outlasts a guest token (GUEST_ROSTER_TAIL_MS against GUEST_TOKEN_TTL_S).
// Rooms with guests admitted are checked every minute besides
// (callGuests.sweepGuestRooms), which is what catches a guest who never says
// anything to the server at all.
//
// A leaf module (no function module imports) so callRooms, calls, transcripts
// and callGuests all reach it without an import cycle.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/** After an admission ends, the roster is checked now and then again at each
 *  of these delays: past a reconnect's backoff, and past the life of the last
 *  token the guest was handed. */
export const GUEST_ROSTER_TAIL_MS = [5_000, 30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;

/** Check the room's media roster now, then down the tail. `tail` is where in
 *  GUEST_ROSTER_TAIL_MS the check starts; the length means one look, no tail. */
export async function checkGuestRoster(ctx: any, roomKey: string, opts: { once?: boolean } = {}): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.callGuests.enforceGuestRoster, {
    room_key: roomKey,
    tail: opts.once ? GUEST_ROSTER_TAIL_MS.length : 0,
  });
}

/** Write a guest's new state and, if that state no longer lets them in the
 *  call, make the media server agree. Idempotent at the media server: a guest
 *  who is not connected is simply not found. */
export async function settleGuest(
  ctx: any,
  guest: Doc<"call_guests">,
  patch: Partial<Pick<Doc<"call_guests">, "status" | "left_reason" | "decided_by" | "decided_at">>,
): Promise<void> {
  await ctx.db.patch(guest._id, patch);
  if ((patch.status ?? guest.status) !== "admitted") await checkGuestRoster(ctx, guest.room_key);
}

/** The huddle in this room is over: every admission was for it, so each one
 *  ends ("huddle_ended") and the media room is cleared of guests. Guests still
 *  WAITING stay: somebody who opened a link ahead of the next meeting is
 *  exactly who that meeting should find at its door. */
export async function endGuestAdmissions(ctx: any, roomKey: string): Promise<number> {
  const admitted: Doc<"call_guests">[] = await ctx.db
    .query("call_guests")
    .withIndex("by_room_status", (q: any) => q.eq("room_key", roomKey).eq("status", "admitted"))
    .collect();
  for (const g of admitted) await ctx.db.patch(g._id, { status: "left", left_reason: "huddle_ended" });
  if (admitted.length > 0) await checkGuestRoster(ctx, roomKey);
  return admitted.length;
}

/** Record that an admitted guest was in this call, once. A call record lists
 *  its outsiders from these rows (by_transcript), each under the name the
 *  room let in, so a guest who comes back to next week's meeting on the same
 *  link is in both records, and neither is rewritten by the other. */
export async function noteGuestAttendance(
  ctx: any,
  guest: Pick<Doc<"call_guests">, "_id" | "name">,
  transcriptId: Id<"transcripts">,
  at: number,
): Promise<void> {
  const seen = await ctx.db
    .query("call_guest_attendance")
    .withIndex("by_guest_transcript", (q: any) => q.eq("guest_id", guest._id).eq("transcript_id", transcriptId))
    .first();
  if (seen) return;
  await ctx.db.insert("call_guest_attendance", {
    transcript_id: transcriptId,
    guest_id: guest._id,
    name: guest.name,
    joined_at: at,
  });
}
