import { useSyncExternalStore } from "react";
import { Captions, CaptionsOff } from "lucide-react";
import { useConvex } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import {
  getScribeStatus,
  startScribe,
  stopScribe,
  subscribeScribe,
} from "../../lib/calls/transcription";

// The transcribe toggle for the call stage's control bar. The person who
// toggles it becomes the scribe (their client streams every audio track to
// ASR). Where the words GO is a separate gesture: the stage's transcript
// rail manages feeds (sessions, docs, Slack) via the palette pick mode — and adding a
// feed there auto-starts transcription, so this button is just the plain
// on/off for people who only want the record.
export function TranscribeControls({ getRoom }: { getRoom: () => any }) {
  const convex = useConvex();
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, () => ({
    active: false,
    transcriptId: null,
    trackCount: 0,
    error: null,
    tail: [],
  }));
  const roomKey = useInboxStore((s) => s.call.roomKey);

  const toggle = async () => {
    if (scribe.active) {
      await stopScribe();
      return;
    }
    const room = getRoom();
    if (!room || !roomKey) return;
    await startScribe({ convex: convex as any, room, roomKey, routes: [] });
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
