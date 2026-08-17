import { useCallsAvailable } from "../../lib/teamFeatures";
import { Headphones } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { joinCall } from "../../lib/calls/callManager";

// "Someone is in here" — the live-room affordance for channel rows and
// session headers. Renders nothing while the room is empty (rooms are keys,
// not entities; an empty room does not exist), a facepile + join otherwise.
// Occupancy rows arrive via useCallSync/getRoomOccupancy for every key the
// screen currently shows.
export function OccupancyChip({
  roomKey,
  className = "",
}: {
  roomKey: string;
  className?: string;
}) {
  const s = useTrackedStore([
    (st: any) => st.callOccupancy[roomKey],
    (st: any) => st.call.roomKey === roomKey,
  ]);
  const roster: any[] = s.callOccupancy[roomKey] || [];
  const inThisRoom = s.call.roomKey === roomKey;
  if (roster.length === 0) return null;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!inThisRoom) void joinCall(roomKey);
      }}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
        inThisRoom
          ? "cursor-default border-sol-violet/50 bg-sol-violet/20 text-sol-violet"
          : "border-sol-violet/30 bg-sol-violet/10 text-sol-violet hover:bg-sol-violet/20"
      } ${className}`}
      title={
        inThisRoom
          ? "You're in this huddle"
          : `${roster.map((m) => m.user_name).join(", ")} — join the huddle`
      }
    >
      <Headphones className="h-3 w-3" />
      <span className="flex -space-x-1.5">
        {roster.slice(0, 3).map((m) => (
          <span
            key={m.user_id}
            className="inline-block h-4 w-4 overflow-hidden rounded-full border border-sol-bg"
          >
            {m.user_image ? (
              <img src={m.user_image} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center bg-sol-base02 text-[8px]">
                {(m.user_name || "?").charAt(0).toUpperCase()}
              </span>
            )}
          </span>
        ))}
      </span>
      <span>{inThisRoom ? "in huddle" : "join"}</span>
    </button>
  );
}

// The "start a huddle about this session" button for session headers: shows
// the chip when the room is live, a quiet start affordance otherwise. Hidden
// entirely when calling isn't configured.
export function SessionHuddleButton({ conversationId }: { conversationId: string }) {
  const enabled = useCallsAvailable();
  const roomKey = `session:${conversationId}`;
  const occupied = useInboxStore((st) => (st.callOccupancy[roomKey]?.length ?? 0) > 0);
  if (!enabled) return null;
  if (occupied) return <OccupancyChip roomKey={roomKey} />;
  return (
    <button
      onClick={() => void joinCall(roomKey)}
      className="flex items-center gap-1 rounded-full border border-sol-border px-2 py-0.5 text-xs text-sol-text-dim transition-colors hover:border-sol-violet/40 hover:text-sol-violet"
      title="Start a huddle about this session — teammates see it and can join"
    >
      <Headphones className="h-3 w-3" />
      <span>huddle</span>
    </button>
  );
}
