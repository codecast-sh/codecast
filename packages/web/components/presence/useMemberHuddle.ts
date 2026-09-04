import { useMemo } from "react";
import { dmRoomKey } from "@codecast/shared/contracts";
import { joinCall, knockRoom, startHuddle } from "../../lib/calls/actions";
import type { LiveRoomRow } from "../../hooks/useLiveRooms";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { showCallPanel } from "../../lib/desktop";
import { huddleInOtherWindow } from "../../lib/calls/huddleWindow";

export interface MemberHuddle {
  /** The word on the control: Join huddle · Huddle · Knock · Knocked. */
  label: string;
  title: string;
  /** The knock is already at the door: a state, not a gesture. */
  waiting: boolean;
  go: () => void;
}

/**
 * One gesture for "get into a huddle with this person", wherever their face is.
 *
 * In a huddle the viewer may join (`in_room_key` is only sent when they may):
 * the control becomes "join them" — ringing someone out of the room they are
 * sitting in is the one wrong gesture. A LOCKED huddle sends no room key at
 * all, so the live-rooms list is what finds it, and the control knocks: the
 * same gesture, one door further out. Otherwise, one click rings them.
 *
 * `room` is passed IN rather than subscribed to here, so a roster of twenty
 * rows shares the one live-rooms subscription its list already holds.
 */
export function useMemberHuddle(
  member: any,
  viewerId: string,
  room: LiveRoomRow | null,
  displayName: string,
): MemberHuddle {
  useDesktopWindowRole();
  const elsewhere = huddleInOtherWindow();
  const memberId = String(member?._id ?? "");
  const inRoomKey: string | undefined = member?.in_room_key;
  const lockedRoom = !inRoomKey && room?.locked ? room : null;
  const knocked = !!lockedRoom?.knocked;
  const lockedRoomKey = lockedRoom?.roomKey;

  return useMemo(() => {
    if (elsewhere) return { label: "Open huddle", title: "Show the huddle window", waiting: false, go: () => { void showCallPanel(); } };
    const label = inRoomKey
      ? "Join huddle"
      : !lockedRoomKey
        ? "Huddle"
        : knocked
          ? "Knocked"
          : "Knock";
    // "Knocked" is a state, not a gesture: the knock is already at the door and
    // there is nothing left to do but wait for it to open. The button used to
    // stay fully enabled and hover-lit in that state while its handler returned
    // immediately, so a click on a perfectly ordinary-looking button did nothing
    // at all and said nothing about why. LiveNow answers this same state by
    // rendering no control; in a row of equal-width siblings the button keeps
    // its place and stops pretending instead.
    const title = inRoomKey
      ? "Join the huddle — you arrive muted"
      : !lockedRoomKey
        ? `Ring ${displayName} into a huddle`
        : knocked
          ? "They can see you at the door"
          : "This huddle is locked — knock to ask in";
    const go = () => {
      if (inRoomKey) void joinCall(inRoomKey, { intent: "deliberate" });
      else if (lockedRoomKey) {
        if (!knocked) void knockRoom(lockedRoomKey);
      } else
        void startHuddle({
          roomKey: dmRoomKey(viewerId, memberId),
          toUserIds: [memberId],
        });
    };
    return { label, title, waiting: knocked, go };
  }, [inRoomKey, lockedRoomKey, knocked, displayName, viewerId, memberId, elsewhere]);
}
