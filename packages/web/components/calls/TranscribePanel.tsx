import { useSyncExternalStore } from "react";
import { Captions, CaptionsOff } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { startTranscribing, stopTranscribing } from "../../lib/calls/callManager";

// The transcription switch, for the ROOM. Every huddle transcribes on its own
// (one seated client becomes the scribe), so what a person switches here is a
// fact about the huddle, not about their window: off says "don't transcribe"
// to every client in it (calls.setRoomTranscribeOff; the scribe's window
// ends its run on seeing the opt-out), and on clears that and starts a run.
//
// Where the words GO is a separate gesture: the transcript rail manages feeds
// (sessions, docs, Slack), and adding a feed starts transcription by itself.
//
// `live` is the room's truth (transcripts.getLive): true while ANYBODY is
// transcribing, which is what the switch shows. A window that only knew its
// own scribe status would read "off" in a room somebody else is transcribing,
// and a person pressing it to stop would find nothing changed.
export function useTranscribeToggle(live: boolean) {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, () => ({
    active: false,
    transcriptId: null,
    trackCount: 0,
    error: null,
    tail: [],
    startedAt: null,
  }));
  const roomKey = useInboxStore((s) => s.call.roomKey);
  const on = live || scribe.active;
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
  return (
    <button
      onClick={() => void toggle()}
      role="switch"
      aria-checked={on}
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
        on
          ? "bg-sol-green/10 text-sol-green hover:bg-sol-red/10 hover:text-sol-red"
          : "bg-white/[0.06] text-sol-text-muted hover:bg-sol-green/10 hover:text-sol-green"
      } ${className}`}
      title={
        on
          ? "Transcribing. Click to stop for the whole huddle; the words so far stay on the call page."
          : "Not transcribing. Click to start; every word lands here and on the call page."
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-sol-green animate-pulse" : "bg-sol-text-dim"}`} />
      transcribing · {on ? "on" : "off"}
    </button>
  );
}
