// "Invite Scribe to every huddle" (lib/calls/huddleSettings): joining or
// starting a huddle in a workspace where it is on invites Scribe, once per
// call per client. The server's claim (transcripts.inviteScribe) settles two
// clients inviting at once, and a Scribe someone removed stays removed.
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { huddleWorkspaceKey, useHuddleSetting } from "../../lib/calls/huddleSettings";
import { useScribe, type ScribeLive } from "./useScribe";

const invitedCalls = new Set<string>();

export function HuddleAutoScribe() {
  const roomKey = useInboxStore((s) => (s.call.phase === "connected" ? s.call.roomKey : null));
  // The same subscription useCallSync holds while seated.
  const live = useQueryNoThrow(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 1 } : "skip").data as ScribeLive;
  const on = useHuddleSetting("huddleAutoScribe", huddleWorkspaceKey(live?.team_id));
  const scribe = useScribe(roomKey, live);
  const callId = live?.transcript_id ?? null;
  useWatchEffect(() => {
    if (!on || !callId || invitedCalls.has(callId)) return;
    invitedCalls.add(callId);
    scribe.invite();
  }, [on, callId]);
  return null;
}
