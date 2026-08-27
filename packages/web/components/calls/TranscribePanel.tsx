import { useSyncExternalStore } from "react";
import { Captions, CaptionsOff } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { startTranscribing, stopTranscribing } from "../../lib/calls/callManager";

// The transcribe toggle for the call stage's control bar. The person who
// toggles it becomes the scribe (their client streams every audio track to
// ASR). Where the words GO is a separate gesture: the stage's transcript
// rail manages feeds (sessions, docs, Slack) via the palette pick mode — and adding a
// feed there auto-starts transcription, so this button is just the plain
// on/off for people who only want the record.
export function TranscribeControls() {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, () => ({
    active: false,
    transcriptId: null,
    trackCount: 0,
    error: null,
    tail: [],
  }));
  const roomKey = useInboxStore((s) => s.call.roomKey);

  // Every huddle transcribes on its own; this is the way to say no (for the
  // whole room, not just this window) and the way back.
  const toggle = async () => {
    if (!roomKey) return;
    if (scribe.active) await stopTranscribing(roomKey);
    else await startTranscribing(roomKey);
  };

  return (
    <button
      onClick={() => void toggle()}
      className={`rounded-full p-2 transition-colors ${
        scribe.active
          ? "bg-sol-green/15 text-sol-green hover:bg-sol-green/25"
          : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text"
      }`}
      title={scribe.active ? "Stop transcribing" : "Transcribe this huddle"}
    >
      {scribe.active ? (
        <Captions className="h-[18px] w-[18px]" />
      ) : (
        <CaptionsOff className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
