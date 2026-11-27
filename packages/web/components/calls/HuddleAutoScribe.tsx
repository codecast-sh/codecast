// "Invite Scribe to every huddle" (lib/calls/huddleSettings): joining or
// starting a huddle in a workspace where it is on invites Scribe. The server
// holds the rules (transcripts.inviteScribe): one Scribe per call, and an
// automatic invite is refused once somebody removed Scribe from the call, so
// a reload or a late joiner never brings it back. Only a person's own seat in
// a real huddle asks: never a recording (it has no room) and never a guest.
import { useInboxStore } from "../../store/inboxStore";
import { useAutoScribe } from "../../hooks/useAutoScribe";

export function HuddleAutoScribe() {
  useAutoScribe(useInboxStore((s) => (s.call.phase === "connected" ? s.call.roomKey : null)));
  return null;
}
