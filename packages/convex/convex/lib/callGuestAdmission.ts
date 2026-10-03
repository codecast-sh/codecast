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
// anything to the server at all, and so are running huddles whose room put a
// guest out within GUEST_SETTLED_WATCH_MS, and every huddle that starts in a
// room with a guest link (callRooms.expireRoomGrants): a client still holding
// a token LiveKit refreshed for it is found by whichever of those runs next,
// so Tuesday's guest is not in Wednesday's meeting whatever their client does.
// The roster check also strips a put-out guest's rights before removing them
// (livekitServer.putOutOfRoom), so a token refreshed after it carries none.
//
// A leaf module (no function module imports) so callRooms, calls, transcripts
// and callGuests all reach it without an import cycle.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { CALL_MEMBER_STALE_MS, GUEST_ADMISSION_LAPSE_MS, guestDisplayName } from "@codecast/shared/contracts";

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

/** How long after a guest is put out the minute sweep keeps checking the
 *  media room of a huddle still running there. Past the roster tail, so the
 *  two overlap, and long enough for any meeting that guest could still be
 *  holding open. */
export const GUEST_SETTLED_WATCH_MS = 60 * 60_000;

/** A room's guests in one status, sorted by id so a subscription that carries
 *  them stays byte-stable between beats. Bounded by the lease the status
 *  keeps (a knock the seat's, an admission its own window): rows from pages
 *  that closed long ago are never read, however many a leaked link made.
 *  `all` drops the bound, for the writers that end every admission. */
export async function roomGuestRows(
  ctx: any,
  roomKey: string,
  status: "waiting" | "admitted",
  now: number,
  opts: { all?: boolean } = {},
): Promise<Doc<"call_guests">[]> {
  const since = status === "waiting" ? CALL_MEMBER_STALE_MS : GUEST_ADMISSION_LAPSE_MS;
  const rows: Doc<"call_guests">[] = await ctx.db
    .query("call_guests")
    .withIndex("by_room_status_seen", (q: any) => {
      const r = q.eq("room_key", roomKey).eq("status", status);
      return opts.all ? r : r.gte("last_seen", now - since);
    })
    .collect();
  return rows.sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

/** Write new states for some of a room's guests and, for those it puts out
 *  of a call they could have been in, make the media server agree with one
 *  roster check and stamp settled_at (the sweep's watch). The one writer of
 *  an ending (callGuests' deny, remove, leave, sweep and beat, and every
 *  huddle end below), so neither can be skipped by one of them. A knock
 *  settled at the door (denied, walked away, abandoned) never had the media
 *  and costs LiveKit nothing; a REMOVAL always checks, whatever the row said
 *  before, since "put out" must hold even for a row marked gone that is
 *  still holding the media open. Idempotent at the media server: a guest who
 *  is not connected is simply not found. */
export async function settleGuests(
  ctx: any,
  roomKey: string,
  rows: ReadonlyArray<Doc<"call_guests">>,
  patch: Partial<Pick<Doc<"call_guests">, "status" | "left_reason" | "decided_by" | "decided_at">>,
): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  let out = false;
  for (const g of rows) {
    const status = patch.status ?? g.status;
    const putOut = status !== "admitted" && status !== "waiting" && (g.status !== "waiting" || status === "removed");
    await ctx.db.patch(g._id, { ...patch, ...(putOut ? { settled_at: now } : {}) });
    out ||= putOut;
  }
  if (out) await checkGuestRoster(ctx, roomKey);
}

export async function settleGuest(
  ctx: any,
  guest: Doc<"call_guests">,
  patch: Parameters<typeof settleGuests>[3],
): Promise<void> {
  await settleGuests(ctx, guest.room_key, [guest], patch);
}

/** Does anybody hold a way into this room from outside? One index read; a
 *  room nobody ever made a guest link for has no guest to look for. */
export async function roomHasGuestLinks(ctx: any, roomKey: string): Promise<boolean> {
  return !!(await ctx.db
    .query("call_guest_links")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .first());
}

/** The huddle in this room is over: every admission was for it, so each one
 *  ends ("huddle_ended") and the media room is cleared of guests. Guests still
 *  WAITING stay: somebody who opened a link ahead of the next meeting is
 *  exactly who that meeting should find at its door. */
export async function endGuestAdmissions(ctx: any, roomKey: string): Promise<number> {
  const admitted = await roomGuestRows(ctx, roomKey, "admitted", Date.now(), { all: true });
  await settleGuests(ctx, roomKey, admitted, { status: "left", left_reason: "huddle_ended" });
  return admitted.length;
}

/** Record that an admitted guest was in this call, once. A call record lists
 *  its outsiders from these rows (callGuestsOnRecord), each under the name
 *  the room let in, so a guest who comes back to next week's meeting on the
 *  same link is in both records, and neither is rewritten by the other. */
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

/** The outsiders a call record had in it, spoken or not, each marked as a
 *  guest in the name itself (a record is read where no badge follows), in
 *  the order they came in. The caller has already passed the record's own
 *  access rule; this reads nothing a reader of the record could not see. */
export async function callGuestsOnRecord(
  ctx: any,
  transcriptId: Id<"transcripts">,
): Promise<Array<{ name: string; joined_at: number }>> {
  const rows: Doc<"call_guest_attendance">[] = await ctx.db
    .query("call_guest_attendance")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", transcriptId))
    .collect();
  return rows
    .sort((a, b) => a.joined_at - b.joined_at)
    .map((r) => ({ name: guestDisplayName(r.name), joined_at: r.joined_at }));
}
