import { useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import { getRoomThreadSeen, isArrival } from "../lib/calls/roomThreadSeen";
import { soundAgentReply, soundChatMessage } from "../lib/sounds";
import { useRoomThreadUnread } from "./useRoomThreadUnread";
import { useWatchEffect } from "./useWatchEffect";

/**
 * The sound for a line in the call you are in. An agent's line always plays
 * the agent chime, rail open or closed, stage up or collapsed: people are
 * talking and watching faces, and an answer they asked for must not land
 * unheard. A person's line plays the team chat's knock (same switch) unless
 * the thread is open in a focused window, where it is read as it lands.
 *
 * Only lines that arrive while this runs: the backlog of a room you walk into
 * is history. Several lines in one push sound once, the agent's cue winning.
 */
export function useRoomThreadAlerts(): void {
  const roomKey = useInboxStore((st: any) => (st.call.phase === "idle" ? null : st.call.roomKey ?? null));
  const { rows } = useRoomThreadUnread(roomKey);
  const heard = useRef<{ roomKey: string | null; at: number | null }>({ roomKey: null, at: null });
  const newestAt = rows?.[rows.length - 1]?.at ?? 0;

  useWatchEffect(() => {
    if (!roomKey || !rows) return;
    const mark = heard.current;
    if (mark.roomKey !== roomKey || mark.at === null) {
      heard.current = { roomKey, at: newestAt };
      return;
    }
    const since = mark.at;
    heard.current = { roomKey, at: Math.max(since, newestAt) };
    const fresh = rows.filter((r) => r.at > since && isArrival(r));
    const agentLine = fresh.findLast((r) => r.agent);
    if (agentLine) soundAgentReply(String(agentLine._id));
    else if (fresh.length > 0 && !getRoomThreadSeen(roomKey).watching) soundChatMessage(String(fresh[fresh.length - 1]._id));
  }, [roomKey, rows, newestAt]);
}
