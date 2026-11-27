import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { GuestWaiting } from "../store/callRoomTypes";
import { useLiveRoomRows, type LiveRoomRow } from "./liveRoomRows";
import { guestsStillWaiting } from "../lib/calls/knockToasts";
import { useNowWhen } from "./useCoarseNow";
import { useFaceRow } from "./useFaceRow";
import { liveRoomOnlyMine, personalViewerOf } from "../lib/calls/personalCalls";
import { roomIsOwnerOnly } from "../lib/faces/faceRowSigs";
import { findSessionRow } from "../lib/calls/findSessionRow";

// The live-rooms read layer lives in ./liveRoomRows (platform-neutral); this
// file binds it to the face row, web's answer to "which room am I in".
export type { LiveRoomRow } from "./liveRoomRows";

export function useLiveRooms(): LiveRoomRow[] {
  return useLiveRoomRows(useFaceRow().room);
}

/** The rooms a Live now list shows: every live room in a team workspace, and
 *  in Personal only the viewer's own (liveRoomOnlyMine). */
export function useLiveNowRooms(): LiveRoomRow[] {
  const rows = useLiveRooms();
  const personalViewer = useInboxStore(personalViewerOf);
  return useMemo(
    () => {
      if (personalViewer === null) return rows;
      // Whose session: read when the rooms change; an owner's own sessions
      // are in their store.
      const st = useInboxStore.getState();
      const ownerOf = (id: string) => {
        const row = findSessionRow(st, id);
        return row?.user_id ? String(row.user_id) : null;
      };
      return rows.filter((r) => liveRoomOnlyMine(r, personalViewer, ownerOf));
    },
    [rows, personalViewer],
  );
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

/** Who may walk into the room I'm in. `team`: any teammate walks in.
 *  `locked`: teammates see it and knock. `private`: listed only to the people
 *  it admits, chosen when the huddle starts (calls.joinRoom). */
export type RoomDoor = "team" | "locked" | "private";

/** The door of a room I'm in: its state and the gesture that sets it. Any
 *  occupant may lock or open it; the huddle is theirs while it runs, and the
 *  lock dies with it (the server clears it when the room restarts from empty).
 *  Private is set only at the start, so the door can leave it (opening the
 *  room) but never enter it. Local-first: the store flips on click
 *  (callRooms), the echo reconciles. */
export function useRoomDoor(roomKey: string | null): {
  door: RoomDoor;
  /** Only its owner may enter (roomIsOwnerOnly): private, and no gesture opens it. */
  fixed: boolean;
  setDoor: (door: Exclude<RoomDoor, "private">) => void;
} {
  const fixed = useInboxStore((st: any) => !!roomKey && roomIsOwnerOnly(st, roomKey));
  const door = useInboxStore((st: any) => {
    const r = roomKey ? st.callRooms?.[roomKey] : undefined;
    return r?.private ? "private" : r?.locked ? "locked" : "team";
  }) as RoomDoor;
  return {
    door,
    fixed,
    setDoor: (next) => {
      if (roomKey && next !== door) useInboxStore.getState().setRoomLocked(roomKey, next === "locked");
    },
  };
}
