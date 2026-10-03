import { useMemo } from "react";
import { useInboxStore, type GuestWaiting } from "../store/inboxStore";
import { useLiveRoomRows, type LiveRoomRow } from "./liveRoomRows";
import { guestsStillWaiting } from "../lib/calls/knockToasts";
import { useNowWhen } from "./useCoarseNow";
import { useFaceRow } from "./useFaceRow";

// The live-rooms read layer lives in ./liveRoomRows (platform-neutral); this
// file binds it to the face row, web's answer to "which room am I in".
export type { LiveRoomRow } from "./liveRoomRows";

export function useLiveRooms(): LiveRoomRow[] {
  return useLiveRoomRows(useFaceRow().room);
}

/** A room nobody is in, with guests at its door on the viewer's own link. */
export type GuestsWaitingRow = {
  roomKey: string;
  /** The meeting as the guest's link names it; null when it has no name. */
  title: string | null;
  /** Their names as they typed them, in the order they knocked. */
  names: string[];
};

/** The rooms where a guest is waiting for ME to show up: guests on my links
 *  at a door nobody is behind (callGuests.listGuestsWaiting, fed by
 *  useCallSync), one row per room. A guest whose lease ran out is dropped by
 *  the clock, because nothing pushes a page that simply closed. Always
 *  mounted (the sidebar), so it wakes on what a row shows and on a lease
 *  actually crossing its end, never on a beat. */
export function useGuestsWaiting(): GuestsWaitingRow[] {
  const sigOf = (list: GuestWaiting[], seated: string | null, now: number) =>
    guestsStillWaiting(list, now, seated)
      .map((g) => `${g.guest_id}:${g.name}:${g.room_key}:${g.title ?? ""}`)
      .join("|");
  const myRoom = useFaceRow().room;
  const list = useInboxStore((st: any) => st.guestsWaiting ?? NO_GUESTS) as GuestWaiting[];
  const now = useNowWhen((t) => sigOf(list, myRoom, t), 5_000);
  const sig = sigOf(list, myRoom, now);
  return useMemo(() => {
    const rows = new Map<string, GuestsWaitingRow>();
    for (const g of guestsStillWaiting(list, now, myRoom)) {
      const row = rows.get(g.room_key) ?? { roomKey: g.room_key, title: g.title, names: [] };
      row.names.push(g.name);
      rows.set(g.room_key, row);
    }
    return [...rows.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

const NO_GUESTS: GuestWaiting[] = [];

/** The huddle a teammate is sitting in, or null. The strip's own `in_room_key`
 *  answers this for rooms the viewer may JOIN; this also finds the locked ones,
 *  which is what lets the hover card offer a knock instead of a ring. */
export function useLiveRoomOfMember(userId: string | null): LiveRoomRow | null {
  const rows = useLiveRooms();
  return useMemo(
    () =>
      userId
        ? rows.find((r) => r.members.some((m) => String(m.user_id) === String(userId))) ?? null
        : null,
    [rows, userId],
  );
}

/** The live row for one room, or null when nobody is in it. Rooms are keys,
 *  not entities: an empty room does not exist. */
export function useLiveRoom(roomKey: string | null): LiveRoomRow | null {
  const rows = useLiveRooms();
  return useMemo(
    () => (roomKey ? rows.find((r) => r.roomKey === roomKey) ?? null : null),
    [rows, roomKey],
  );
}

/** The lock on a room I'm in: its state and the gesture that flips it. Any
 *  occupant may lock — the huddle is theirs while it runs, and the lock dies
 *  with it (the server clears it when the room restarts from empty).
 *  Local-first: the glyph flips on click (callRooms), the echo reconciles. */
export function useRoomLock(roomKey: string | null): {
  locked: boolean;
  toggle: () => void;
  title: string;
} {
  const room = useLiveRoom(roomKey);
  const locked = !!room?.locked;
  return {
    locked,
    toggle: () => {
      if (roomKey) useInboxStore.getState().setRoomLocked(roomKey, !locked);
    },
    title: locked
      ? "Locked — teammates must knock. Click to open the room again"
      : "Open room — any teammate can walk in. Click to lock it",
  };
}
