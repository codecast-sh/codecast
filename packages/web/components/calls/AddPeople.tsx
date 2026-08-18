import { useMemo, useState } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { MemberPicker } from "../chat/ChannelPeople";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { ringInto } from "../../lib/calls/callManager";
import { describeRoom } from "../../lib/calls/roomLabels";
import { memberDisplayName } from "../../lib/liveEntities";

// "Add people" for a live huddle: the chat member picker in a popover, on
// the room you are in. Picking rings everyone chosen into THIS room — the
// ring is their grant, so a teammate outside the room's anchor (a 1:1, a
// private channel, a session) can answer it while the huddle runs. Whoever
// is already in the room, already ringing, or is you is left out of the list.
export function AddPeopleButton({
  roomKey,
  className = "",
  iconClassName = "h-4 w-4",
  align = "end",
}: {
  roomKey: string;
  className?: string;
  iconClassName?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const s = useTrackedStore([
    (st: any) => (st.callOccupancy[roomKey] ?? []).map((m: any) => m.user_id).join("|"),
    (st: any) =>
      st.myCalls.outgoing
        .filter((o: any) => o.room_key === roomKey && o.status === "ringing")
        .map((o: any) => o.to_user)
        .join("|"),
    (st: any) => st.currentUser?._id,
  ]);
  const exclude = useMemo(() => {
    const ids = new Set<string>();
    if (s.currentUser?._id) ids.add(String(s.currentUser._id));
    for (const m of s.callOccupancy[roomKey] ?? []) ids.add(String(m.user_id));
    for (const o of s.myCalls.outgoing) {
      if (o.room_key === roomKey && o.status === "ringing") ids.add(String(o.to_user));
    }
    return [...ids];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.callOccupancy[roomKey], s.myCalls.outgoing, s.currentUser?._id, roomKey]);

  const ring = async (ids: string[]) => {
    setOpen(false);
    const st = useInboxStore.getState();
    const { anchorTitle } = describeRoom(roomKey, st as any);
    const results = await ringInto(roomKey, ids, anchorTitle).catch((err: any) => {
      toast.error(err?.message || "Could not ring them");
      return [];
    });
    // Per-recipient outcomes worth a word: refused (not on this team) and
    // cooldown (they declined a minute ago). Busy rings quietly and the
    // outgoing row shows it as ringing, so it needs no toast.
    const byId = new Map((st.teamMembers ?? []).map((m: any) => [String(m._id), m]));
    for (const r of results) {
      const name = memberDisplayName(byId.get(String(r.to_user)), "Teammate");
      if (r.refused) toast.error(`${name} can't be rung into this huddle`);
      else if (r.cooldown) toast(`${name} declined a moment ago — try again in a minute`);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={className || "rounded-md p-1.5 text-sol-text-muted transition-colors hover:bg-sol-base02"}
          title="Add people — ring teammates into this huddle"
        >
          <UserPlus className={iconClassName} />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} sideOffset={6} className="ch-people-pop z-[300]">
        <div className="ch-people-title">
          <UserPlus className="w-3 h-3 opacity-60" />
          Ring into this huddle
        </div>
        <MemberPicker exclude={exclude} submitLabel="Ring" onPick={(ids) => void ring(ids)} />
      </PopoverContent>
    </Popover>
  );
}
