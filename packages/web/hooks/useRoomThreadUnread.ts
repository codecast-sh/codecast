import { api } from "@codecast/convex/convex/_generated/api";
import type { ThreadRow } from "../components/calls/roomThreadModel";
import { countUnread, markRoomThreadSeen, setRoomThreadWatching, useRoomThreadSeen } from "../lib/calls/roomThreadSeen";
import { useEventListener } from "./useEventListener";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

/**
 * A room's thread rows and how many of them arrived unread. `open` is the
 * caller drawing the thread itself: its rows are seen as they land, and while
 * this window has focus the room is watched, so no other surface counts or
 * knocks for it. Every other caller (the header's door, the chime) passes
 * nothing and only reads.
 */
export function useRoomThreadUnread(
  roomKey: string | null | undefined,
  open = false,
): { rows: ThreadRow[] | null | undefined; unread: number } {
  const rows = useQueryNoThrow(api.callChat.list, roomKey ? { room_key: roomKey } : "skip").data as
    | ThreadRow[]
    | null
    | undefined;
  const seen = useRoomThreadSeen(roomKey);
  const newestAt = rows?.[rows.length - 1]?.at ?? 0;

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

  return { rows, unread: open ? 0 : countUnread(rows, seen) };
}
