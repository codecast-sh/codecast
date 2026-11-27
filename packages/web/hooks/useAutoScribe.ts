// "Invite Scribe to every huddle" (lib/calls/huddleSettings), as a hook both
// apps mount: web's HuddleAutoScribe and the phone's call screen. The server
// holds the rules (transcripts.inviteScribe): one Scribe per call, and an
// automatic invite is refused once somebody removed Scribe from the call.
// Only a person's own seat in a real huddle asks: never a recording or a
// meeting room (no room) and never a guest.
import { api } from "@codecast/convex/convex/_generated/api";
import { callParticipantKind, isRoomlessKey } from "@codecast/shared/contracts";
import { useMyUserId } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { huddleWorkspace, useHuddleSetting } from "../lib/calls/huddleSettings";
import { useScribe, type ScribeLive } from "../components/calls/useScribe";

// Asked already from this window: only a debounce, the server decides.
const askedCalls = new Set<string>();

/** The rule, for whichever app knows where this person is seated (`seated`:
 *  the connected call's room key, or null). The phone mounts it too. */
export function useAutoScribe(seated: string | null, onError?: (title: string, message: string) => void) {
  const me = useMyUserId();
  const roomKey = seated && !isRoomlessKey(seated) && me && callParticipantKind(String(me)) === "person" ? seated : null;
  // The same subscription useCallSync holds while seated.
  const live = useQueryNoThrow(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 1 } : "skip").data as ScribeLive;
  const on = useHuddleSetting("huddleAutoScribe", huddleWorkspace(roomKey, live, me)?.key ?? null);
  const scribe = useScribe(roomKey, live, onError);
  const callId = live?.transcript_id ?? null;
  useWatchEffect(() => {
    if (!on || !callId || askedCalls.has(callId)) return;
    askedCalls.add(callId);
    void scribe.invite({ auto: true });
  }, [on, callId]);
}
