// Which calls belong to the viewer alone: what the Calls page lists in the
// Personal workspace, and where a task made from a call is filed. Read off the
// call list's rows (convex callReads.shapeCallRow) and the live rooms, so the
// page answers from the store on its first frame.
import { callParticipantKind, dmRoomKey, isRoomlessKey, parseRoomKey } from "@codecast/shared/contracts";
import { activeTeamIdOf } from "../activeTeam";

/** The viewer's id while the Personal workspace is active ("" before the
 *  viewer is known, which matches nothing), null in a team workspace. */
export function personalViewerOf(s: any): string | null {
  return activeTeamIdOf(s) ? null : s?.currentUser?._id ? String(s.currentUser._id) : "";
}

export type CallPrivacyRow = {
  room_key?: string | null;
  started_by?: string | null;
  rec_shared?: boolean | null;
  /** The record was stamped private (a private huddle, or a room only its
   *  owner may enter). */
  private?: boolean | null;
  participants?: { id: string }[] | null;
};

/** A recording or meeting bot's call its creator has not shared into a team. */
function ownUnsharedRecording(call: CallPrivacyRow, viewerId: string): boolean {
  return isRoomlessKey(call.room_key) && String(call.started_by ?? "") === viewerId && !call.rec_shared;
}

/** The call is private to the people in it: the viewer's room of one, a
 *  private huddle, or the viewer's own unshared recording. A task made from
 *  it goes to the viewer's Personal workspace, never the team it routes to. */
export function callIsPrivate(call: CallPrivacyRow, viewerId: string): boolean {
  if (!viewerId) return false;
  if (call.room_key === dmRoomKey(viewerId)) return true;
  if (isRoomlessKey(call.room_key)) return ownUnsharedRecording(call, viewerId);
  return call.private === true;
}

/** Only the viewer can read it: their room of one, a private session huddle
 *  with no other person in it (an owner-only session huddle, whose agent may
 *  speak), or their own unshared recording. What Personal's Calls page
 *  lists. */
export function callOnlyMine(call: CallPrivacyRow, viewerId: string): boolean {
  if (!callIsPrivate(call, viewerId)) return false;
  if (call.room_key === dmRoomKey(viewerId) || isRoomlessKey(call.room_key)) return true;
  // A people room's key names everyone it is for; only a session room can be
  // one person's while its key names nobody.
  if (parseRoomKey(call.room_key ?? "")?.kind !== "session") return false;
  return (
    String(call.started_by ?? "") === viewerId &&
    (call.participants ?? []).every((p) => String(p.id) === viewerId || callParticipantKind(String(p.id)) === "agent")
  );
}

/** A live room only the viewer is in and only they may enter: their room of
 *  one, or a private room with nobody else seated. Personal's Live now. */
export function liveRoomOnlyMine(
  row: { roomKey: string; private?: boolean; members: { user_id: string }[] },
  viewerId: string,
): boolean {
  if (!viewerId) return false;
  if (row.roomKey === dmRoomKey(viewerId)) return true;
  return !!row.private && !isRoomlessKey(row.roomKey) && row.members.every((m) => String(m.user_id) === viewerId);
}
