import { useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import { getRoomThreadSeen, isArrival } from "../lib/calls/roomThreadSeen";
import { soundChatMessage } from "../lib/sounds";
import { useRoomThreadUnread } from "./useRoomThreadUnread";
import { useWatchEffect } from "./useWatchEffect";

/**
 * The knock for a line typed in the call you are in, by a person or by an
 * agent in the room. A call's chat sits behind a closed rail or a collapsed
 * stage most of the time, so without a sound a question asked there goes
 * unanswered. The team chat's knock, not a new cue: it is chat, it obeys the
 * same switch, and the message id collapses the windows that each see it.
 *
 * Only lines that arrive while this runs: the backlog of a room you walk into
 * is history. Several lines in one push knock once. Nothing sounds while the
 * thread is open in a focused window, where the line is read as it lands.
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
    if (fresh.length === 0 || getRoomThreadSeen(roomKey).watching) return;
    soundChatMessage(String(fresh[fresh.length - 1]._id));
  }, [roomKey, rows, newestAt]);
}
