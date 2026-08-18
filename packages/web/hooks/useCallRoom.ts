import { useMemo } from "react";
import { useTrackedStore } from "../store/inboxStore";
import { describeRoom } from "../lib/calls/roomLabels";

// The caller's side of a ring in one room: who is still ringing and who
// declined (the server keeps declines visible for 30s so the dock can settle
// the sentence). Names and faces come off the row itself — the outgoing
// projection is enriched server-side, so no roster lookup is needed here.
export function useOutgoingRings(roomKey: string | null): {
  ringing: { user_id: string; user_name: string; user_image?: string }[];
  declined: { user_id: string; user_name: string; user_image?: string }[];
} {
  const s = useTrackedStore([
    (st: any) =>
      st.myCalls.outgoing
        .filter((o: any) => o.room_key === roomKey)
        .map((o: any) => `${o._id}:${o.status}`)
        .join("|"),
  ]);
  return useMemo(() => {
    const rows = (s.myCalls.outgoing as any[]).filter((o) => o.room_key === roomKey);
    const shape = (o: any) => ({ user_id: String(o.to_user), user_name: o.to_name, user_image: o.to_image });
    return {
      ringing: rows.filter((o) => o.status === "ringing").map(shape),
      declined: rows.filter((o) => o.status === "declined").map(shape),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.myCalls.outgoing, roomKey]);
}

// The room's live name for a component: re-derives when the roster, the
// channel or the session it names changes.
export function useRoomDescription(roomKey: string | null) {
  // A signature of what the name depends on, not the collections themselves:
  // teamMembers churns on every presence heartbeat and would re-derive the
  // label (and re-render the dock) for nothing.
  const s = useTrackedStore([
    (st: any) => (st.teamMembers ?? []).map((m: any) => `${m._id}:${m.name ?? m.email ?? ""}`).join("|"),
    (st: any) => {
      const id = roomKey ? roomKey.split(":")[1] : "";
      const ch = id ? st.chatChannels?.[id] : undefined;
      const rail = id ? (st.chatRail ?? []).find((r: any) => String(r.channel_id) === id) : undefined;
      return ch ? `${ch.kind ?? ""}:${ch.name ?? ""}:${(rail?.member_ids ?? []).join(",")}` : "";
    },
    (st: any) => st.currentUser?._id,
  ]);
  // Re-renders are already gated by the signatures above, so deriving on
  // each render is the cheap and honest choice.
  return describeRoom(roomKey, s as any);
}
