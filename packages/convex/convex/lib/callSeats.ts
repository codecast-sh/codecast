// Shaping and classing a call's seats: the roster row a client sees, a ring
// still alive, a seat's transcribe languages, and what a seat in a room means
// to somebody outside it (calls.ts, teams.ts).

import type { Doc } from "../_generated/dataModel";
import { CALL_INVITE_TTL_MS, parseRoomKey } from "../callRooms";
import { bucketTs } from "../presenceState";
import { normalizeTranscribeLanguages } from "@codecast/shared/contracts";

/** Seat languages the transcriber unions. Undefined means "this client did not say". */
export function stampedLanguages(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const langs = normalizeTranscribeLanguages(raw);
  return langs.length ? langs : undefined;
}

export function inviteAlive(inv: Doc<"call_invites">, now: number): boolean {
  return inv.status === "ringing" && now - inv.created_at < CALL_INVITE_TTL_MS;
}

// The client-facing shape of a roster row. last_seen deliberately never
// leaves the server (it churns every heartbeat and shows nothing the UI
// paints); joined_at is bucketed so the row is byte-stable across pushes.
export function projectMember(m: Doc<"call_members">) {
  return {
    room_key: m.room_key,
    user_id: m.user_id,
    user_name: m.user_name,
    user_image: m.user_image,
    joined_at: bucketTs(m.joined_at),
    muted: m.muted,
    camera: m.camera,
    sharing: m.sharing,
    // The one bit that turns a burst into a call, for everyone in the room.
    // Bucketed like joined_at and set once, so it never re-pushes the roster.
    walkie_joined_at: m.walkie_joined_at ? bucketTs(m.walkie_joined_at) : undefined,
  };
}

/**
 * WHAT A SEAT IN THIS ROOM MEANS TO SOMEBODY OUTSIDE IT.
 *
 * A walkie burst seats everyone who hears it, and the seat is held for half a
 * minute after the key comes up so an answer lands without a rejoin. Read as
 * "in a huddle", three seconds of somebody's voice lit every teammate's
 * roster for the whole window, and nobody outside the room could tell that
 * from an hour in a call. The seat rows carry no intent flag, so the class is
 * read off what the room already records:
 *
 *   call    a channel or session huddle (always deliberate), a people room
 *           somebody stepped into on purpose (a walkie_joined_at stamp on
 *           ANY live seat, since one deliberate join makes the room a call
 *           for everyone in it), or a people room somebody was rung into
 *           (an accepted invite of the running huddle; joinRoom cancels the
 *           grants when the room restarts from empty).
 *   walkie  a people room with none of those: seats a burst put there, and
 *           the linger after it.
 *
 * Invites change on a ring and an answer only, so reading them here adds no
 * churn to a roster that already re-runs at heartbeat rate.
 */
export type SeatClass = "call" | "walkie";

export async function roomSeatClass(
  ctx: { db: any },
  roomKey: string,
  liveRows: Pick<Doc<"call_members">, "walkie_joined_at">[],
): Promise<SeatClass> {
  if (parseRoomKey(roomKey)?.kind !== "dm") return "call";
  if (liveRows.some((m) => !!m.walkie_joined_at)) return "call";
  const invites: Doc<"call_invites">[] = await ctx.db
    .query("call_invites")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  return invites.some((i) => i.status === "accepted") ? "call" : "walkie";
}
