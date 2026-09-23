import { useCallsAvailable } from "../../lib/teamFeatures";
import { useCallback, useState } from "react";
import type { FaceRow } from "../../lib/faces/faceRow";
import { useFaceRowSelect } from "../../hooks/useFaceRow";
import { roomHeldAsBurst } from "../../lib/faces/faceRow";
import { Headphones } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { joinCall, startHuddle } from "../../lib/calls/actions";
import { CHANNEL_HUDDLE_WARNING_SIZE, parseRoomKey, sessionRoomKey } from "@codecast/shared/contracts";
import { AvatarImg } from "../../lib/avatarCache";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "../ui/dialog";

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
  // A burst joins a room exactly the way a huddle does, so without this the DM
  // header put a violet "in huddle" chip on a three-second voice message, six
  // inches from the face row already showing who is talking. The row is the
  // one that knows what is happening (lib/faces/faceRow roomHeldAsBurst), so
  // this stands down while the room is held as a burst and comes back the
  // moment the row's links say it became a call.
  const burst = useFaceRowSelect(useCallback((row: FaceRow) => roomHeldAsBurst(roomKey, row), [roomKey]));
  const roster: any[] = s.callOccupancy[roomKey] || [];
  const inThisRoom = s.call.roomKey === roomKey;
  if (roster.length === 0) return null;
  if (burst) return null;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void joinCall(roomKey, { intent: "deliberate" });
      }}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors ${compact ? "text-[10px] font-medium" : "text-xs"} ${
        inThisRoom
          ? "border-sol-violet/50 bg-sol-violet/20 text-sol-violet hover:bg-sol-violet/25"
          : "border-sol-violet/30 bg-sol-violet/10 text-sol-violet hover:bg-sol-violet/20"
      } ${className}`}
      title={
        inThisRoom
          ? "Show the huddle window"
          : `${roster.map((m) => m.user_name).join(", ")} — join the huddle`
      }
    >
      <Headphones className="h-3 w-3" />
      <Facepile members={roster} size={16} />
      <span className="cq-sq2">{inThisRoom ? "in huddle" : "join"}</span>
    </button>
  );
}

// The "start a huddle here" button for anything with a room: shows the chip
// when the room is live, a quiet start affordance otherwise. Hidden entirely
// when calling isn't configured. `ring` names people to ring the moment the
// room opens; `anchorTitle` is the ring toast's "about:" line.
//
// The empty room is an affordance, not information, so at header scale it is
// the headphones alone — the same shape mobile's button has always had, and
// one less word competing with the pills that do carry information. The
// occupied state keeps its faces and its verb: who is in there IS the news.
export function HuddleButton({
  roomKey,
  ring,
  anchorTitle,
  channelMemberCount,
  hint,
  className = "",
  compact = false,
}: {
  roomKey: string;
  ring?: string[];
  anchorTitle?: string;
  channelMemberCount?: number;
  /** What this room's huddle is for, when it is more than "talk here" — the
   *  session room says the agent listens. */
  hint?: string;
  className?: string;
  /** Header-chip scale (10px, soft border) to sit flush with the other
   *  conversation-header pills; the chat page keeps the larger default. */
  compact?: boolean;
}) {
  const enabled = useCallsAvailable();
  const occupied = useInboxStore((st) => (st.callOccupancy[roomKey]?.length ?? 0) > 0);
  const [warningRoom, setWarningRoom] = useState<string | null>(null);
  const isChannel = parseRoomKey(roomKey)?.kind === "channel";
  if (!enabled) return null;
  if (occupied) return <OccupancyChip roomKey={roomKey} className={className} compact={compact} />;
  const label =
    hint ??
    (isChannel
      ? "Start a huddle and buzz everyone in the channel"
      : ring?.length
        ? `Start a huddle and ring ${ring.length === 1 ? "them" : "everyone here"}`
        : "Start a huddle here — teammates see it and can join");
  const start = () =>
    isChannel || ring?.length
      ? void startHuddle({ roomKey, toUserIds: ring ?? [], anchorTitle, ringChannel: isChannel })
      : void joinCall(roomKey, { intent: "deliberate" });
  return (
    <Dialog open={warningRoom === roomKey} onOpenChange={(open) => setWarningRoom(open ? roomKey : null)}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-huddle-idle
          disabled={isChannel && channelMemberCount === undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (!isChannel || (channelMemberCount ?? 0) <= CHANNEL_HUDDLE_WARNING_SIZE) {
              e.preventDefault();
              start();
            }
          }}
          className={`flex items-center gap-1 rounded-full border text-sol-text-dim transition-colors hover:border-sol-violet/40 hover:text-sol-violet disabled:opacity-50 ${compact ? "border-sol-border/40 px-1.5 py-1 text-[10px] font-medium" : "border-sol-border px-2 py-0.5 text-xs"} ${className}`}
          title={label}
          aria-label={label}
        >
          <Headphones className="h-3 w-3" />
          {!compact && <span>{ring?.length ? "Ring" : "Huddle"}</span>}
        </button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-lg border-sol-border bg-sol-bg text-sol-text" onClick={(e) => e.stopPropagation()}>
        <DialogTitle className="pr-6 text-base">Buzz everyone in {anchorTitle || "this channel"}?</DialogTitle>
        <DialogDescription className="text-sm text-sol-text-muted">
          This channel has {channelMemberCount} members. Starting a huddle will buzz all {Math.max(0, (channelMemberCount ?? 1) - 1)} other members.
        </DialogDescription>
        <DialogFooter className="gap-2 sm:space-x-0">
          <DialogClose asChild>
            <button type="button" className="rounded-md border border-sol-border px-3 py-2 text-sm hover:bg-sol-bg-highlight">Cancel</button>
          </DialogClose>
          <button type="button" className="rounded-md bg-sol-violet px-3 py-2 text-sm text-sol-base3 hover:opacity-90" onClick={() => { setWarningRoom(null); start(); }}>Start and buzz everyone</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Session headers: the room of one conversation, and the one room where the
// agent is listening — a session huddle transcribes into its own session live
// (transcripts.start seeds the route), so the tooltip says so.
export function SessionHuddleButton({ conversationId }: { conversationId: string }) {
  return (
    <HuddleButton
      roomKey={sessionRoomKey(conversationId)}
      hint="Talk to this session — what you say reaches the agent as you speak"
      compact
    />
  );
}
