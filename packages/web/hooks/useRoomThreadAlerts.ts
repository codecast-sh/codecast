import { useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import { getRoomThreadSeen, isArrival } from "../lib/calls/roomThreadSeen";
import { getDesktopWindowRole, hasBrowserNotificationPermission, isElectron, isRoomAnnouncer, notifyNative } from "../lib/desktop";
import { cleanNotificationBody } from "../lib/notificationText";
import { soundAgentReply, soundChatMessage } from "../lib/sounds";
import type { ThreadRow } from "../components/calls/roomThreadModel";
import { useWindowPresent } from "./usePagePresence";
import { useRoomThreadUnread } from "./useRoomThreadUnread";
import { useWatchEffect } from "./useWatchEffect";

/**
 * The sound for a line in the call you are in. An agent's line always plays
 * the agent chime, rail open or closed, stage up or collapsed, whichever
 * window has focus: people are talking and watching faces, and an answer they
 * asked for must not land unheard. A person's line plays the team chat's
 * knock (same switch) unless the thread is open in a focused window, where it
 * is read as it lands.
 *
 * Every window in the call mounts this, and exactly one of them speaks:
 * isRoomAnnouncer (the voice host on a shell that has one, else the leader).
 *
 * The call's own surfaces show an agent's answer (AgentReplyPeek: over the
 * stage, or hanging from the call's pill); with no app window in front of
 * the person it also goes up as a system banner.
 *
 * Only lines that arrive while this runs: the backlog of a room you walk into
 * is history. Several lines in one push sound once, the agent's cue winning.
 */
export function useRoomThreadAlerts(): void {
  const roomKey = useInboxStore((st: any) => (st.call.phase === "idle" ? null : st.call.roomKey ?? null));
  const { rows } = useRoomThreadUnread(roomKey);
  const present = useWindowPresent();
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
    if (!isRoomAnnouncer()) return;
    const fresh = rows.filter((r) => r.at > since && isArrival(r));
    const agentLine = fresh.findLast((r) => r.agent);
    if (agentLine) {
      soundAgentReply(String(agentLine._id));
      if (!present && !getDesktopWindowRole().appFocused) bannerAgentReply(agentLine);
    } else if (fresh.length > 0 && !getRoomThreadSeen(roomKey).watching) soundChatMessage(String(fresh[fresh.length - 1]._id));
  }, [roomKey, rows, newestAt]);
}

function bannerAgentReply(row: ThreadRow): void {
  if (!isElectron() && !hasBrowserNotificationPermission()) return;
  const name = row.agent!.name ?? row.agent!.title;
  void notifyNative(`${name} replied in the call`, cleanNotificationBody(row.text, 300), { key: `call-agent-reply:${row._id}` });
}
