import { useMemo } from "react";
import { useTrackedStore } from "../store/inboxStore";
import { describeRoom } from "../lib/calls/roomLabels";

type RingRow = { user_id: string; user_name: string; user_image?: string };

function firstName(name: string | undefined): string {
  return (name || "").split(/\s+/)[0] || "Teammate";
}

// The caller's side of a ring in one room: who is still ringing, who
// declined, and who never answered (the server keeps declined and expired
// rows visible for 30s so the dock can settle the sentence). Names and faces
// come off the row itself — the outgoing projection is enriched server-side.
// The composed lines live here too, so the pill and the stage read the same
// words for the same state.
export function useOutgoingRings(roomKey: string | null): {
  ringing: RingRow[];
  declined: RingRow[];
  noAnswer: RingRow[];
  /** "ringing sam, ana…" while phones ring; null otherwise. */
  ringingLine: string | null;
  /** "ana declined" / "no answer from sam" for a settling beat; null otherwise. */
  settledLine: string | null;
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
    const shape = (o: any): RingRow => ({ user_id: String(o.to_user), user_name: o.to_name, user_image: o.to_image });
    const ringing = rows.filter((o) => o.status === "ringing").map(shape);
    // A fresh re-ring outranks the same person's settled rows: "sam ·
    // ringing…" and "no answer from sam" must never share a screen.
    const live = new Set(ringing.map((r) => r.user_id));
    const declined = rows
      .filter((o) => o.status === "declined" && !live.has(String(o.to_user)))
      .map(shape);
    const noAnswer = rows
      .filter((o) => o.status === "expired" && !live.has(String(o.to_user)))
      .map(shape);
    const names = (list: RingRow[]) => list.map((r) => firstName(r.user_name)).join(", ");
    return {
      ringing,
      declined,
      noAnswer,
      ringingLine: ringing.length ? `ringing ${names(ringing)}…` : null,
      settledLine: declined.length
        ? `${names(declined)} declined`
        : noAnswer.length
          ? `no answer from ${names(noAnswer)}`
          : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.myCalls.outgoing, roomKey]);
}

// The room's live name for a component: re-derives when the roster, the
// channel, the live occupancy, or the session it names changes.
export function useRoomDescription(roomKey: string | null) {
  // Signatures of what the name depends on, not the collections themselves:
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
    // Guests appear in the live roster and nowhere in the key.
    (st: any) =>
      ((roomKey && st.callOccupancy?.[roomKey]) || []).map((m: any) => m.user_id).join("|"),
    // A session room is named by its conversation's title, which can land
    // after the dock mounts (LLM titles arrive late).
    (st: any) => {
      if (!roomKey || !roomKey.startsWith("session:")) return "";
      const id = roomKey.split(":")[1];
      const conv =
        st.conversations?.[id] ??
        Object.values(st.conversations ?? {}).find((c: any) => String(c?._id) === id) ??
        Object.values(st.sessions ?? {}).find((c: any) => String(c?._id) === id);
      return (conv as any)?.title ?? (conv as any)?.name ?? "";
    },
    (st: any) => st.currentUser?._id,
  ]);
  // Re-renders are already gated by the signatures above, so deriving on
  // each render is the cheap and honest choice.
  return describeRoom(roomKey, s as any);
}
