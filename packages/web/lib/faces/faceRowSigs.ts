// The input signatures faceRow.ts memoizes on: each folds one input into a
// string that moves only when a field a face draws moved.
import type { FaceLiveRoom, FaceMember, FaceSeat } from "./faceRow";
import { walkieHoldsRoom, walkieJoinedRoom, type WalkieStatus } from "../calls/walkie";
import { teamBarSig } from "../../components/presence/memberPresence";

export function idOf(v: unknown): string {
  return v == null ? "" : String(v);
}

export function seatSig(seats: FaceSeat[] | undefined): string {
  let s = "";
  for (const m of seats ?? []) s += `${idOf(m.user_id)}:${m.muted ? 1 : 0}:${m.camera ? 1 : 0}:${m.walkie_joined_at ?? ""},`;
  return s;
}

export function occupancySig(occ: Record<string, FaceSeat[]> | undefined): string {
  let s = "";
  for (const k in occ ?? {}) s += `${k}=${seatSig(occ![k])};`;
  return s;
}

export function liveRoomsSig(rooms: FaceLiveRoom[] | undefined): string {
  let s = "";
  for (const r of rooms ?? []) {
    s += `${r.room_key}|${r.seat ?? ""}|${r.private ? 1 : 0}|${seatSig(r.members)}|${(r.guests ?? []).map((g) => `${g.identity}:${g.name}`).join(",")}\n`;
  }
  return s;
}

export function lockedRoomsSig(rooms: Record<string, { locked?: boolean; private?: boolean }> | undefined): string {
  let s = "";
  for (const k in rooms ?? {}) if (rooms![k]?.locked || rooms![k]?.private) s += `${k}${rooms![k]?.private ? "!" : ""},`;
  return s;
}

/** A huddle listed only to the people it admits: started private and still
 *  shut, or a room only its owner may enter. The server's `private` lands on
 *  the room's flags (applyLiveRoomsPush), whose home is `callRooms`, flipped
 *  locally, so opening the door (which clears it) reads at once. */
export function roomIsPrivate(st: any, roomKey: string): boolean {
  return !!st.callRooms?.[roomKey]?.private;
}

/** Only its owner may enter the room (a room of one, a session huddle the
 *  team cannot read), as the server says (getLiveRooms `owner_only`),
 *  whether or not it was also started private. No gesture opens it. */
export function roomIsOwnerOnly(st: any, roomKey: string): boolean {
  return !!st.callRooms?.[roomKey]?.owner_only;
}

export function rosterFaceSig(members: FaceMember[] | undefined): string {
  // teamBarSig carries identity, presence, status and the room; the walkie
  // fields the row adds ride beside it.
  let extra = "";
  for (const m of members ?? []) {
    if (!m?._id) continue;
    extra += `${m.seat ?? ""}|${m.walkie_joined_at ?? ""}|${m.walkie_pref ?? ""}|${m.walkie_snoozed_until ?? ""}|${m.is_bot ? m.bot_kind ?? "bot" : ""}\n`;
  }
  return teamBarSig((members ?? []) as any[]) + extra;
}

export function ringsSig(myCalls: { incoming?: any[]; outgoing?: any[] } | undefined): string {
  let s = "";
  for (const r of myCalls?.incoming ?? []) s += `in:${idOf(r.from_user)}:${r.room_key}:${r.from_name ?? ""},`;
  for (const r of myCalls?.outgoing ?? []) s += `out:${idOf(r.to_user)}:${r.room_key}:${r.status ?? ""}:${r.to_name ?? ""},`;
  return s;
}

export function walkieRowSig(w: WalkieStatus): string {
  const s = w.sending;
  const live = w.liveRoom;
  return `${live?.key ?? ""}|${live?.mode ?? ""}|${s ? `${s.roomKey}:${s.live ? 1 : 0}:${s.heardLive ? 1 : 0}` : ""}|${w.incoming?.fromUserId ?? ""}:${w.incoming?.roomKey ?? ""}|${w.canReply ? 1 : 0}|${walkieJoinedRoom(w) ?? ""}|${walkieHoldsRoom(w, null) ? 1 : 0}`;
}
