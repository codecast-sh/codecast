import { useMemo } from "react";
import { useTrackedStore, type LiveRoom } from "../store/inboxStore";
import { describeRoomLive } from "../lib/calls/roomLabels";
import { setRoomLock } from "../lib/calls/actions";
import { useNowWhen } from "./useCoarseNow";
import { CALL_KNOCK_TTL_MS } from "@codecast/shared/contracts";

// The live-rooms read layer: one derivation of "which huddles are running and
// what may I do about each", shared by the sidebar's Live now cluster, the
// /calls page's Happening now section and the team strip's hover card. The
// rows come from the store (calls.getLiveRooms feeds it in useCallSync), so
// every surface paints synchronously and they can never disagree.
//
// Wake discipline: these are always-mounted surfaces and call_members
// heartbeats push liveRooms constantly, so the subscription is a SIGNATURE of
// exactly what a row renders — never the collection itself. Membership churn
// inside a room I already show wakes nobody unless the facepile changes.

export type LiveRoomRow = {
  roomKey: string;
  /** "#design", "Ann, Bo", the session's title, or "a huddle" when redacted. */
  label: string;
  /** The room's door is shut. Paints the lock glyph, and nothing else: a
   *  locked room is still joinable by everyone the lock does not exclude. */
  locked: boolean;
  /** I may walk into this room right now (the server's own authorizeRoom
   *  answer). Join versus Knock branches on THIS: calls.knock refuses anyone
   *  who could just join, so a button that read `locked` handed a member of a
   *  locked room a knock that always failed. */
  canJoin: boolean;
  /** A session huddle whose conversation this viewer cannot see: joinable,
   *  but unnamed — the room list must not leak titles. */
  redacted: boolean;
  members: { user_id: string; user_name?: string; user_image?: string }[];
  /** I am seated in this room right now. */
  mine: boolean;
  /** I knocked at this locked door and it has not opened yet. */
  knocked: boolean;
};

function roomsSig(rooms: LiveRoom[]): string {
  let sig = "";
  for (const r of rooms) {
    sig += `${r.room_key}|${r.locked ? 1 : 0}|${r.can_join ? 1 : 0}|${r.redacted ? 1 : 0}|${r.title ?? ""}|`;
    for (const m of r.members) sig += `${m.user_id},`;
    sig += "\n";
  }
  return sig;
}

export function useLiveRooms(): LiveRoomRow[] {
  const s = useTrackedStore([
    (st: any) => roomsSig(st.liveRooms ?? []),
    // Label inputs. Teammate names (a rename renames the huddle), the channel
    // a channel room is named after, and my own identity — all cheap
    // signatures, none of them the churny collection.
    (st: any) => (st.teamMembers ?? []).map((m: any) => `${m._id}:${m.name ?? m.email ?? ""}`).join("|"),
    // The anchor each live room is named after, and only those: a channel
    // rename or a late-arriving session title must rename the row, while the
    // rest of the store's channels and conversations wake nobody.
    (st: any) =>
      (st.liveRooms ?? [])
        .map((r: any) => {
          const id = String(r.room_key).split(":")[1] ?? "";
          const ch = st.chatChannels?.[id];
          if (ch) return `${id}:${ch.kind ?? ""}:${ch.name ?? ""}`;
          const conv = st.conversations?.[id] ?? st.sessions?.[id];
          return conv ? `${id}:${conv.title ?? conv.name ?? ""}` : id;
        })
        .join("|"),
    (st: any) => st.currentUser?._id,
    (st: any) => st.call.roomKey,
    (st: any) => Object.keys(st.callKnocked ?? {}).sort().join("|"),
  ]);
  const knocked: Record<string, number> = s.callKnocked ?? {};
  // A knock expires on its own after the server's TTL; that is a clock
  // transition, not a field change, so it needs its own tick — one that wakes
  // the surface only when a knock actually crosses the threshold.
  const now = useNowWhen(
    (t) =>
      Object.entries(knocked)
        .filter(([, at]) => t - at < CALL_KNOCK_TTL_MS)
        .map(([k]) => k)
        .join("|"),
    5_000,
  );

  return useMemo(() => {
    const rooms: LiveRoom[] = s.liveRooms ?? [];
    const me = String(s.currentUser?._id ?? "");
    return rooms.map((room) => {
      const { label } = describeRoomLive(room.room_key, s as any);
      return {
        roomKey: room.room_key,
        label,
        locked: room.locked,
        canJoin: room.can_join,
        redacted: room.redacted,
        members: room.members,
        mine:
          s.call.roomKey === room.room_key ||
          room.members.some((m) => String(m.user_id) === me),
        knocked: now - (knocked[room.room_key] ?? 0) < CALL_KNOCK_TTL_MS,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.liveRooms, s.teamMembers, s.chatChannels, s.currentUser?._id, s.call.roomKey, knocked, now]);
}

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
 *  Local-first: the glyph flips on click, the liveRooms echo reconciles. */
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
      if (roomKey) void setRoomLock(roomKey, !locked);
    },
    title: locked
      ? "Locked — teammates must knock. Click to open the room again"
      : "Open room — any teammate can walk in. Click to lock it",
  };
}
