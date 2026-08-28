import { useCallsAvailable } from "../../lib/teamFeatures";
import { useWalkieStatus } from "../../hooks/useWalkie";
import { walkieHoldsRoom } from "../../lib/calls/walkie";
import { Headphones } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { joinCall, startHuddle } from "../../lib/calls/callManager";
import { sessionRoomKey } from "@codecast/shared/contracts";
import { AvatarImg } from "../../lib/avatarCache";

// The faces in a room, in one idiom: every live-room surface (this chip, the
// sidebar's Live now cluster, /calls' Happening now) shows the same overlapped
// avatars with the same initial fallback, so a room looks like itself wherever
// it appears.
export function Facepile({
  members,
  max = 3,
  size = 16,
  className = "",
}: {
  members: { user_id: string; user_name?: string; user_image?: string }[];
  max?: number;
  /** Avatar diameter in px. */
  size?: number;
  className?: string;
}) {
  const extra = members.length - max;
  return (
    <span className={`flex shrink-0 -space-x-1.5 ${className}`}>
      {members.slice(0, max).map((m) => (
        <span
          key={m.user_id}
          className="inline-block overflow-hidden rounded-full border border-sol-bg"
          style={{ height: size, width: size }}
        >
          <AvatarImg
            src={m.user_image}
            alt=""
            className="h-full w-full object-cover"
            fallback={
              <span
                className="flex h-full w-full items-center justify-center bg-sol-bg-highlight text-sol-text-muted"
                style={{ fontSize: Math.max(8, Math.round(size / 2)) }}
              >
                {(m.user_name || "?").charAt(0).toUpperCase()}
              </span>
            }
          />
        </span>
      ))}
      {extra > 0 && (
        <span
          className="inline-flex items-center justify-center rounded-full border border-sol-bg bg-sol-bg-highlight text-sol-text-muted"
          style={{ height: size, width: size, fontSize: Math.max(8, Math.round(size / 2)) }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

// "Someone is in here" — the live-room affordance for channel rows and
// session headers. Renders nothing while the room is empty (rooms are keys,
// not entities; an empty room does not exist), a facepile + join otherwise.
// Occupancy rows arrive via useCallSync/getRoomOccupancy for every key the
// screen currently shows.
export function OccupancyChip({
  roomKey,
  className = "",
  compact = false,
}: {
  roomKey: string;
  className?: string;
  /** Header-chip scale — see HuddleButton. */
  compact?: boolean;
}) {
  const s = useTrackedStore([
    (st: any) => st.callOccupancy[roomKey],
    (st: any) => st.call.roomKey === roomKey,
  ]);
  // The same question CallDock asks, and for the same reason: a burst joins a
  // room exactly the way a huddle does, so without this the DM header put a
  // violet "in huddle" chip on a three-second voice message — six inches from
  // a walkie strip already saying "Live to Jordan Lee". Two surfaces, two
  // names, one thing. The strip is the one that knows what is happening, so
  // this stands down while the walkie holds the room, and comes back the moment
  // the room becomes a real huddle — which the live room's own mode says, so
  // there is one answer here and in the dock rather than two.
  const walkie = useWalkieStatus();
  const roster: any[] = s.callOccupancy[roomKey] || [];
  const inThisRoom = s.call.roomKey === roomKey;
  if (roster.length === 0) return null;
  if (inThisRoom && walkieHoldsRoom(walkie, roomKey)) return null;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!inThisRoom) void joinCall(roomKey, { intent: "deliberate" });
      }}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors ${compact ? "text-[10px] font-medium" : "text-xs"} ${
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
      <Facepile members={roster} size={16} />
      <span>{inThisRoom ? "in huddle" : "join"}</span>
    </button>
  );
}

// The "start a huddle here" button for anything with a room: shows the chip
// when the room is live, a quiet start affordance otherwise. Hidden entirely
// when calling isn't configured. `ring` names people to ring the moment the
// room opens (a DM or group thread rings its members; a channel or session
// is an open door and rings nobody); `anchorTitle` is the ring toast's
// "about:" line.
export function HuddleButton({
  roomKey,
  ring,
  anchorTitle,
  className = "",
  compact = false,
}: {
  roomKey: string;
  ring?: string[];
  anchorTitle?: string;
  className?: string;
  /** Header-chip scale (10px, soft border) to sit flush with the other
   *  conversation-header pills; the chat page keeps the larger default. */
  compact?: boolean;
}) {
  const enabled = useCallsAvailable();
  const occupied = useInboxStore((st) => (st.callOccupancy[roomKey]?.length ?? 0) > 0);
  if (!enabled) return null;
  if (occupied) return <OccupancyChip roomKey={roomKey} className={className} compact={compact} />;
  const start = () =>
    ring?.length
      ? void startHuddle({ roomKey, toUserIds: ring, anchorTitle })
      : void joinCall(roomKey, { intent: "deliberate" });
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        start();
      }}
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-sol-text-dim transition-colors hover:border-sol-violet/40 hover:text-sol-violet ${compact ? "border-sol-border/40 text-[10px] font-medium" : "border-sol-border text-xs"} ${className}`}
      title={
        ring?.length
          ? `Start a huddle and ring ${ring.length === 1 ? "them" : "everyone here"}`
          : "Start a huddle here — teammates see it and can join"
      }
    >
      <Headphones className="h-3 w-3" />
      <span>huddle</span>
    </button>
  );
}

// Session headers: the room of one conversation.
export function SessionHuddleButton({ conversationId }: { conversationId: string }) {
  return <HuddleButton roomKey={sessionRoomKey(conversationId)} compact />;
}
