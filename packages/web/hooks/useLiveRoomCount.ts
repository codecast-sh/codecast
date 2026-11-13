import { useInboxStore } from "../store/inboxStore";
import { teamMembersOf } from "../lib/activeTeam";

/** How many huddles are live right now: the distinct occupied rooms across
 *  the roster, plus the room I'm in myself (my own heartbeat may not have
 *  landed in the roster yet). A primitive, so presence churn that changes
 *  nothing re-renders nobody. The Calls row in both rails reads it. */
export function useLiveRoomCount(): number {
  return useInboxStore((s) => {
    const keys = new Set<string>();
    // The authoritative list (calls.getLiveRooms) plus the strip's view of it:
    // the union keeps the dot honest before the query has landed, and adds the
    // rooms only the server list knows about (a teammate outside my strip, a
    // huddle whose occupants hide their room key).
    for (const r of (s as any).liveRooms ?? []) keys.add(r.room_key);
    for (const m of teamMembersOf(s)) if (m?.in_room_key) keys.add(m.in_room_key);
    if (s.call?.roomKey) keys.add(s.call.roomKey);
    return keys.size;
  });
}
