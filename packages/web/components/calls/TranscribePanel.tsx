import { useSyncExternalStore } from "react";
import { Captions, CaptionsOff } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useRoomTranscribeOff } from "../../hooks/useRoomTranscribeOff";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { startTranscribing, stopTranscribing } from "../../lib/calls/callManager";
import { TranscribeSwitchView } from "./TranscribeSwitchView";

// The transcription switch, for the ROOM. Every huddle transcribes on its own
// (one seated client becomes the scribe), so what a person switches here is a
// fact about the huddle, not about their window: off says "don't transcribe"
// to every client in it (calls.setRoomTranscribeOff; the scribe's window
// ends its run on seeing the opt-out), and on clears that and starts a run.
//
// Where the words GO is a separate gesture: the transcript rail manages feeds
// (sessions, docs, Slack), and adding a feed starts transcription by itself.
//
// `live` is the room's truth (transcripts.getLive): true while the huddle has
// a record that ANYBODY is transcribing into, which is what the switch shows. A window that only knew its
// own scribe status would read "off" in a room somebody else is transcribing,
// and a person pressing it to stop would find nothing changed.
function useTranscribeToggle(live: boolean) {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, () => ({
    active: false,
    transcriptId: null,
    trackCount: 0,
    error: null,
    tail: [],
    startedAt: null,
  }));
  const roomKey = useInboxStore((s) => s.call.roomKey);
  const switchedOff = useRoomTranscribeOff(roomKey);
  const on = !switchedOff && (live || scribe.active);
  const toggle = async () => {
    if (!roomKey) return;
    if (on) await stopTranscribing(roomKey);
    else await startTranscribing(roomKey);
  };
  return { on, toggle, roomKey };
}

/** The control bar's round button. */
export function TranscribeControls({ live }: { live: boolean }) {
  const { on, toggle } = useTranscribeToggle(live);
  return (
    <button
      onClick={() => void toggle()}
      className={`rounded-full p-2 transition-colors ${
        on
          ? "bg-sol-green/15 text-sol-green hover:bg-sol-green/25"
          : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text"
      }`}
      title={on ? "Stop transcribing this huddle (for everyone)" : "Transcribe this huddle"}
      aria-pressed={on}
    >
      {on ? <Captions className="h-[18px] w-[18px]" /> : <CaptionsOff className="h-[18px] w-[18px]" />}
    </button>
  );
}

/** The transcript rail's labelled switch: the state in words, and the way
 *  to flip it, where the words themselves are read. */
export function TranscribeSwitch({ live, className = "" }: { live: boolean; className?: string }) {
  const { on, toggle } = useTranscribeToggle(live);
  return <TranscribeSwitchView on={on} onToggle={() => void toggle()} className={className} />;
}

