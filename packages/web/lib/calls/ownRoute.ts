// In a room only its session's owner may enter, that session's own route is
// the owner's to take off: it is their door to the call's record, so the
// server refuses anyone else (transcripts.assertMayDropOwnRoute). The
// controls that take it off read this and stand down for everyone else.
import { sessionRoomConversationId } from "@codecast/shared/contracts";
import { roomIsOwnerOnly } from "../faces/faceRowSigs";
import { findSessionRow } from "./findSessionRow";

/** The route target the viewer may not take out of this room (the session's
 *  own, when the room is its owner's alone and the viewer is not that
 *  owner), else null. A scalar, so it can be a store selector. */
export function ownRouteHeldFrom(st: any, roomKey: string | null | undefined): string | null {
  const own = roomKey ? sessionRoomConversationId(roomKey) : null;
  if (!own || !roomIsOwnerOnly(st, roomKey!)) return null;
  const me = st.currentUser?._id ? String(st.currentUser._id) : "";
  const row = findSessionRow(st, own);
  return me && row && String(row.user_id) === me ? null : own;
}

export const OWN_ROUTE_HELD = "Only the session's owner can take its agent out of this call";
