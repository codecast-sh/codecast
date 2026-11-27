// "Invite Scribe to every huddle" (lib/calls/huddleSettings): joining or
// starting a huddle in a workspace where it is on invites Scribe. The server
// holds the rules (transcripts.inviteScribe): one Scribe per call, and an
// automatic invite is refused once somebody removed Scribe from the call, so
// a reload or a late joiner never brings it back. Only a person's own seat in
// a real huddle asks: never a recording (it has no room) and never a guest.
import { api } from "@codecast/convex/convex/_generated/api";
import { callParticipantKind, isRoomlessKey } from "@codecast/shared/contracts";
import { useInboxStore, useMyUserId } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { huddleWorkspaceKey, useHuddleSetting } from "../../lib/calls/huddleSettings";
import { useScribe, type ScribeLive } from "./useScribe";

// Asked already from this window: only a debounce, the server decides.
const askedCalls = new Set<string>();

export function HuddleAutoScribe() {
  const me = useMyUserId();
  const seated = useInboxStore((s) => (s.call.phase === "connected" ? s.call.roomKey : null));
  const roomKey = seated && !isRoomlessKey(seated) && me && callParticipantKind(String(me)) === "person" ? seated : null;
  // The same subscription useCallSync holds while seated.
  const live = useQueryNoThrow(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 1 } : "skip").data as ScribeLive;
  const on = useHuddleSetting("huddleAutoScribe", huddleWorkspaceKey(live?.team_id));
  const scribe = useScribe(roomKey, live);
  const callId = live?.transcript_id ?? null;
  useWatchEffect(() => {
    if (!on || !callId || askedCalls.has(callId)) return;
    askedCalls.add(callId);
    scribe.invite({ auto: true });
  }, [on, callId]);
  return null;
}
