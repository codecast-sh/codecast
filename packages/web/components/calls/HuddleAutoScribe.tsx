// "Invite Scribe to every huddle" (lib/calls/huddleSettings): joining or
// starting a huddle in a workspace where it is on invites Scribe. The server
// holds the rules (transcriptsScribe.inviteScribe): one Scribe per call, and an
// automatic invite is refused once somebody removed Scribe from the call, so
// a reload or a late joiner never brings it back. Only a person's own seat in
// a real huddle asks: never a recording (it has no room), never a guest, and
// never a seat the walkie holds so a teammate's burst can play, which the
// person never joined.
import { useSyncExternalStore } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useAutoScribe } from "../../hooks/useAutoScribe";
import { getWalkieStatus, subscribeWalkie, walkieHoldsRoom, type WalkieStatus } from "../../lib/calls/walkie";

/** The room this window joined for real: connected, and not a walkie's listening seat. */
function joinedSeat(call: { phase: string; roomKey: string | null }, walkie: WalkieStatus): string | null {
  return call.phase === "connected" && call.roomKey && !walkieHoldsRoom(walkie, call.roomKey) ? call.roomKey : null;
}

export function HuddleAutoScribe() {
  const walkie = useSyncExternalStore(subscribeWalkie, getWalkieStatus, getWalkieStatus);
  const phase = useInboxStore((s) => s.call.phase);
  const roomKey = useInboxStore((s) => s.call.roomKey);
  useAutoScribe(joinedSeat({ phase, roomKey }, walkie));
  return null;
}
