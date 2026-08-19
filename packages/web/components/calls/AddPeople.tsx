import { useMemo, useState } from "react";
import { UserPlus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { MemberPicker } from "../chat/ChannelPeople";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { ringInto } from "../../lib/calls/callManager";
import { describeRoom } from "../../lib/calls/roomLabels";

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
  // Nobody left to ring (small team, everyone in or ringing): no dead button.
  const anyoneLeft = (useInboxStore.getState().teamMembers ?? []).some(
    (m: any) => !m.is_bot && !exclude.includes(String(m._id)),
  );
  if (!anyoneLeft) return null;

  const ring = (ids: string[]) => {
    setOpen(false);
    // People-room context lines are server-derived per recipient; the
    // caller's line only matters for channel and session rooms. Outcome
    // toasts (cooldown, refused, errors) live in ringInto, shared with
    // every other entry point.
    const { anchorTitle } = describeRoom(roomKey, useInboxStore.getState() as any);
    void ringInto(roomKey, ids, anchorTitle);
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
        <MemberPicker exclude={exclude} submitLabel="Ring" onPick={ring} />
      </PopoverContent>
    </Popover>
  );
}
