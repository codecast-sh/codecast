import { useMemo } from "react";
import { dmRoomKey } from "@codecast/shared/contracts";
import { joinCall, knockRoom, ringInto } from "../../lib/calls/actions";
import { requestHuddleStart } from "../../lib/calls/huddleStart";
import { callRoomOf } from "../../lib/faces/faceRow";
import { useFaceRowSelect } from "../../hooks/useFaceRow";
import type { LiveRoomRow } from "../../hooks/useLiveRooms";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { showCallPanel } from "../../lib/desktop";
import { huddleInOtherWindow } from "../../lib/calls/huddleWindow";
import { walkieCallState } from "../../lib/calls/walkie";

/** The call this window holds (the host's, mirrored), or null. Read beside
 *  the face row, which wakes on every change of the call plane. */
const callHereOf = (): string | null => {
  const call = walkieCallState();
  return call.phase === "idle" ? null : call.roomKey ?? null;
};

export interface MemberHuddle {
  /** The word on the control: Join huddle · Huddle · Knock · Knocked. */
  label: string;
  title: string;
  /** The knock is already at the door: a state, not a gesture. */
  waiting: boolean;
  go: () => void;
  /** No gesture belongs here: your own card while you are on somebody
   *  else's call (a huddle with yourself would pull you out of it). */
  hidden?: boolean;
}

/**
 * One gesture for "get into a huddle with this person", wherever their face is.
 *
 * On a call of the viewer's own, the control adds them to it: a ring into
 * the room the viewer is already in. A fresh DM huddle there would pull the
 * viewer off their call.
 *
 * In a huddle the viewer may join (`in_room_key` is only sent when they may):
 * the control becomes "join them" — ringing someone out of the room they are
 * sitting in is the one wrong gesture. A LOCKED huddle sends no room key at
 * all, so the live-rooms list is what finds it, and the control knocks: the
 * same gesture, one door further out. Otherwise, one click rings them.
 *
 * On your own card it is a huddle with yourself: the room of one
 * (`dm:<you>`), rung to nobody, joined when it is already live.
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
  // Their own huddle wins: ringing someone out of the room they sit in is the
  // one wrong gesture, and "Join huddle" is already the way to them.
  const myCall = useFaceRowSelect(callRoomOf);
  const self = !!memberId && memberId === viewerId;
  const addTo = myCall && !inRoomKey && !elsewhere && !self ? myCall : null;
  // Your own card: a huddle with yourself, in the people room of one. It is
  // live when you sit in it anywhere (another window, the phone).
  const ownRoom = self ? dmRoomKey(viewerId) : null;
  // The room this window's call plane holds; your room of one seated only on
  // another device (the phone) is still one to join from here.
  const callHere = useFaceRowSelect(callHereOf);
  const ownRoomLive = !!ownRoom && room?.roomKey === ownRoom;

  return useMemo(() => {
    if (elsewhere) return { label: "Open huddle", title: "Show the huddle window", waiting: false, go: () => { void showCallPanel(); } };
    if (ownRoom) {
      if (callHere === ownRoom) return { label: "In huddle", title: "You are in your huddle", waiting: true, go: () => {} };
      if (myCall && myCall !== ownRoom) return { label: "Huddle", title: "", waiting: true, go: () => {}, hidden: true };
      return ownRoomLive
        ? { label: "Join huddle", title: "Join your huddle — you arrive muted", waiting: false, go: () => { void joinCall(ownRoom, { intent: "deliberate" }); } }
        : { label: "Huddle", title: "Start a huddle with just you", waiting: false, go: () => requestHuddleStart({ roomKey: ownRoom, hint: "Only you" }) };
    }
    if (addTo) return { label: "Add to call", title: `Ring ${displayName} into your call`, waiting: false, go: () => { void ringInto(addTo, [memberId]); } };
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
        requestHuddleStart({
          roomKey: dmRoomKey(viewerId, memberId),
          toUserIds: [memberId],
        });
    };
    return { label, title, waiting: knocked, go };
  }, [inRoomKey, lockedRoomKey, knocked, displayName, viewerId, memberId, elsewhere, addTo, ownRoom, ownRoomLive, myCall, callHere]);
}
