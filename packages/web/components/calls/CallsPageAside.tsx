import { useRouter } from "next/navigation";
import { Mic } from "lucide-react";
import { toast } from "sonner";
import { isRecRoomKey } from "@codecast/shared/contracts";
import { Facepile } from "./OccupancyChip";
import { LiveRoomAction, LiveRoomLabel } from "./LiveNow";
import { RecordButton } from "./RoomRecording";
import { firstName } from "./speakers";
import { useLiveRooms } from "../../hooks/useLiveRooms";
import { useSeatedRoomKey } from "../../hooks/useRoomRecording";
import { useRecorderStatus } from "../../hooks/useRecorder";
import { getRecorderStatus, startRecording } from "../../lib/calls/recorder";

// Rooms with someone seated RIGHT NOW — the same list the sidebar's Live now
// cluster reads (calls.getLiveRooms via the store), so the two can never
// disagree. A transcribed live call already pulses in the Live section below;
// this covers the huddles nobody toggled Transcribe on, which under open rooms
// is most of them. Locked rooms list too — seeing one is what makes knocking
// possible — with Knock in place of Join for the people the lock shuts out.
export function LiveNowSection({ transcribedRoomKeys }: { transcribedRoomKeys: Set<string> }) {
  const rooms = useLiveRooms().filter((r) => !transcribedRoomKeys.has(r.roomKey));
  if (rooms.length === 0) return null;
  return (
    <>
      <div className="bg-sol-bg-alt/30 px-4 py-1.5 text-mark font-medium uppercase tracking-wide text-sol-violet">
        Happening now
      </div>
      {rooms.map((row) => (
        <div
          key={row.roomKey}
          className="flex items-center gap-2 border-b border-sol-border/15 px-4 py-3"
        >
          <Facepile members={row.members} max={4} size={22} />
          <div className="min-w-0 flex-1">
            <LiveRoomLabel row={row} className="text-[13px] font-medium text-sol-text" />
            <div className="mt-0.5 min-w-0 truncate text-meta text-sol-text-dim">
              {row.members.map((m) => firstName(m.user_name)).join(", ")}
            </div>
          </div>
          <LiveRoomAction row={row} />
        </div>
      ))}
    </>
  );
}

/**
 * Start a recording. The only way one ever begins on this page, and it says in
 * as many words where the sound comes from: a microphone in a room, not a tap
 * on the meeting software. Once running, the pill takes over — this button
 * points at the transcript instead of offering a second stop control that
 * could disagree with the one people already found.
 */
export function RecordMeetingButton() {
  const status = useRecorderStatus();
  const router = useRouter();
  const running = status.phase === "recording" || status.phase === "stopping";
  const starting = status.phase === "starting";

  if (running) {
    return (
      <button
        onClick={() => status.transcriptId && router.push(`/calls/${status.transcriptId}`)}
        className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md border border-sol-red/50 bg-sol-red/12 px-3 py-2 text-xs font-medium text-sol-red transition-colors hover:bg-sol-red/20"
      >
        <span className="rec-pill-dot" aria-hidden="true" />
        Recording a voice note. Open it
      </button>
    );
  }

  return (
    <button
      onClick={() =>
        void startRecording().then((id) => {
          // A refused microphone is the common failure and the pill is not up
          // to carry the news — nothing started, so nothing is showing.
          if (id) router.push(`/calls/${id}`);
          else if (getRecorderStatus().error) toast.error(getRecorderStatus().error!);
        })
      }
      disabled={starting}
      title="Records your microphone into a private voice note. It does not film the huddle; use Record in the call for that."
      className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md bg-sol-red/15 px-3 py-2 text-xs font-medium text-sol-red transition-colors hover:bg-sol-red/25 disabled:opacity-50"
    >
      <Mic className="h-3.5 w-3.5" />
      {/* The wait here is a person deciding, not a machine working: Chrome is
          asking them for the microphone and nothing moves until they answer.
          Saying "Starting…" made an unanswered prompt look like a hang. */}
      {starting ? "Waiting for the microphone" : "Record a voice note"}
    </button>
  );
}

/**
 * The huddle the viewer is seated in, filmed from here: the stage's own
 * Record (the same press, first-time question and Stop), above the voice
 * note so the two are never taken for each other. A voice note records this
 * computer's microphone, privately; this records the room, and the room is
 * told. With no huddle to film, a line says where Record lives.
 */
export function SeatedHuddleRecord() {
  const seated = useSeatedRoomKey();
  if (seated && !isRecRoomKey(seated)) {
    return (
      <div className="mt-2.5">
        <RecordButton roomKey={seated} variant="wide" />
      </div>
    );
  }
  return (
    <p className="mt-1 text-meta leading-snug text-sol-text-dim/80">
      To film a huddle, press Record on its card at the top of the window, beside Mute, or on the open call.
    </p>
  );
}
