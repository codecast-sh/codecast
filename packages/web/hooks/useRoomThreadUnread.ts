import { api } from "@codecast/convex/convex/_generated/api";
import type { ThreadRow } from "../components/calls/roomThreadModel";
import { useRef } from "react";
import { isArrival, markRoomThreadSeen, setRoomThreadWatching, unreadArrivals, useRoomThreadSeen } from "../lib/calls/roomThreadSeen";
import { useEventListener } from "./useEventListener";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

/**
 * A room's thread rows and how many of them arrived unread. `open` is the
 * caller drawing the thread itself: its rows are seen as they land, and while
 * this window has focus the room is watched, so no other surface counts or
 * knocks for it. Every other caller (the header's door, the chime) passes
 * nothing and only reads. `latest` is the newest unread line, so a badge can
 * say who it is from (an agent's answer wears the agent's colour).
 * `arrived` is the newest agent answer that landed while this hook watched
 * the room (never the backlog it found): with the thread open nothing is
 * unread, yet an agent's answer still has to reach people watching faces.
 */
export function useRoomThreadUnread(
  roomKey: string | null | undefined,
  open = false,
): { rows: ThreadRow[] | null | undefined; unread: number; latest: ThreadRow | null; arrived: ThreadRow | null } {
  const rows = useQueryNoThrow(api.callChat.list, roomKey ? { room_key: roomKey } : "skip").data as
    | ThreadRow[]
    | null
    | undefined;
  const seen = useRoomThreadSeen(roomKey);
  const newestAt = rows?.[rows.length - 1]?.at ?? 0;
  const base = useRef<{ roomKey: string; at: number } | null>(null);
  if (roomKey && rows && base.current?.roomKey !== roomKey) base.current = { roomKey, at: newestAt };
  const since = base.current?.roomKey === roomKey ? base.current.at : Infinity;
  const arrived = rows?.findLast((r) => r.agent && r.at > since && isArrival(r)) ?? null;

  useWatchEffect(() => {
    if (roomKey && rows) markRoomThreadSeen(roomKey, rows, open);
  }, [roomKey, rows, open, newestAt]);

  const watch = (watching: boolean) => {
    if (roomKey && open) setRoomThreadWatching(roomKey, watching);
  };
  useWatchEffect(() => {
    if (!roomKey || !open) return;
    setRoomThreadWatching(roomKey, document.hasFocus());
    return () => setRoomThreadWatching(roomKey, false);
  }, [roomKey, open]);
  useEventListener("focus", () => watch(true));
  useEventListener("blur", () => watch(false));
  useEventListener("pagehide", () => watch(false));

  const fresh = open ? [] : unreadArrivals(rows, seen);
  return { rows, unread: fresh.length, latest: fresh[fresh.length - 1] ?? null, arrived };
}
