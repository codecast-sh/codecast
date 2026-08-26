// A walkie burst in the chat timeline.
//
// The product argument this renders: THE TRANSCRIPT IS THE MESSAGE. Reading is
// always enough, so the words sit where an ordinary message's words sit, in the
// same type, and the audio is the optional half beside them. That is why there
// is no waveform — a waveform says "you must listen to know what this is", and
// here you never must.
//
// Two states, one row shape:
//
//   LIVE   the sender is still holding the key. A violet dot breathes (the
//          same motion the anchor's "thinking" uses, because it means the same
//          thing: words are still arriving) and the transcript grows in place.
//          Clicking joins the room — the burst is being spoken INTO a live call
//          room, and walking into it is the whole "join in if I see it" move.
//   DONE   play, pause, duration. The recording is an ordinary attachment, so
//          it resolves through the same storage-url path an image does.
//
// It takes a ChatMessageView and nothing else, so it renders from a fixture the
// way the rest of the chat surface does. The two things it can DO — play a
// recording, walk into a live room — go straight to the module singletons that
// own them, which is what keeps a join handler from being threaded down through
// all four surfaces that mount a timeline.
import { useSyncExternalStore } from "react";
import { Play, Pause, Radio } from "lucide-react";
import { useStorageImageUrl } from "../../hooks/useStorageImageUrl";
import { joinCall } from "../../lib/calls/callManager";
import { useWalkieStatus, walkieJoinReason } from "../../hooks/useWalkie";
import {
  getVoicePlayback,
  getVoicePlaybackServer,
  subscribeVoicePlayer,
  toggleVoice,
  voiceAttachment,
  voiceDuration,
} from "../../lib/voicePlayer";
import type { ChatAttachmentView, ChatMessageView } from "./chatTypes";
import "./chat.css";

/** The play control, kept in its own component for the same reason
 *  AttachmentTile is: it is the only thing here that resolves a storage url,
 *  and that reaches for the Convex client. A live bubble has no recording yet,
 *  so it must not pay for one. */
function VoicePlayButton({ messageId, att }: { messageId: string; att: ChatAttachmentView }) {
  const url = useStorageImageUrl(att.storage_id);
  const playback = useSyncExternalStore(
    subscribeVoicePlayer,
    getVoicePlayback,
    getVoicePlaybackServer,
  );
  const mine = playback.key === messageId;
  const playing = mine && playback.playing;
  // The hook says which of the two silences this is: undefined while the url is
  // still resolving, null once the storage object is known to be gone. Saying
  // "not available" through the ordinary loading window called a brief wait a
  // permanent loss. The transcript beside it is untouched either way.
  const resolving = url === undefined;
  const name = resolving
    ? "Getting the recording"
    : !url
      ? "The recording is not available"
      : playing
        ? "Pause"
        : "Play";
  return (
    <button
      type="button"
      className={`ch-voice-play ${playing ? "ch-voice-play-on" : ""}`}
      disabled={!url}
      aria-label={name}
      title={name}
      data-walkie-play={messageId}
      onClick={() => url && toggleVoice(messageId, url)}
    >
      {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
    </button>
  );
}

/** The elapsed/total pair. Only the message being played counts up; every other
 *  bubble shows the length it was, which is what the server told us before the
 *  audio was ever fetched. */
function VoiceClock({ messageId, durationMs }: { messageId: string; durationMs?: number }) {
  const playback = useSyncExternalStore(
    subscribeVoicePlayer,
    getVoicePlayback,
    getVoicePlaybackServer,
  );
  const mine = playback.key === messageId;
  const total = durationMs ?? (mine ? playback.durationMs : 0);
  // Nothing to time. A burst whose finalize never landed carries no duration,
  // and "0:00" beside a transcript claims a recording of no length rather than
  // no recording at all — which the glyph beside it already says correctly.
  if (!total) return null;
  return (
    <span className="ch-voice-clock">
      {mine && playback.positionMs > 0 ? `${voiceDuration(playback.positionMs)} / ` : ""}
      {voiceDuration(total)}
    </span>
  );
}

/**
 * The bubble while the key is still down. Clicking it walks into the room the
 * burst is being spoken into, which is the "join in if I see it" move the open
 * rooms work exists to allow.
 *
 * It reaches for callManager and the walkie directly rather than taking a
 * callback, and that is deliberate: both are module singletons (the same way
 * the play button reaches for the one audio element), so threading a join
 * handler down through all four chat surfaces would buy nothing — and the
 * bubble stays fixture-renderable, with no query and no provider behind it.
 */
function VoiceLiveBubble({ message }: { message: ChatMessageView }) {
  const roomKey = message.voice?.roomKey;
  const transcript = message.content.trim();
  // The snapshot is the wake, not the answer: it moves whenever the call plane
  // does, and the per-room answer is asked fresh below.
  useWalkieStatus();
  // The JOIN question, not the push-to-talk one. Clicking a live bubble walks
  // into the room to listen, and being already in it is no reason to refuse —
  // joinCall is idempotent there. A room you cannot talk into can still be one
  // you are welcome to stand in.
  const reason = walkieJoinReason(roomKey);

  return (
    <div className="ch-msg-body">
      <button
        type="button"
        className="ch-voice ch-voice-live"
        disabled={!!reason}
        data-walkie-live={message.id}
        title={reason ?? "Join the room and talk back"}
        onClick={() => roomKey && void joinCall(roomKey)}
      >
        <span className="ch-voice-pulse" aria-hidden="true">
          <span className="ch-voice-dot" />
        </span>
        <span className="ch-voice-text">
          {/* Motion alone is not an accessible signal, so the state is also a
              word — and until the recognizer has heard anything, that word is
              the whole bubble.
              "No words yet" rather than "talking", because the pulsing dot
              beside it already says somebody is talking and this is the one
              place that can say what is missing. It also rhymes with the
              finished bubble's "no words", so the pair reads as the same fact
              at two moments: not heard YET, and never heard at all. */}
          {transcript || <span className="ch-voice-waiting">no words yet</span>}
        </span>
      </button>
    </div>
  );
}

export function ChatVoiceBubble({ message }: { message: ChatMessageView }) {
  const att = voiceAttachment(message.attachments);
  const transcript = message.content.trim();

  if (message.voice?.status === "live") return <VoiceLiveBubble message={message} />;

  return (
    <div className="ch-msg-body">
      <div className="ch-voice">
        {att ? (
          <VoicePlayButton messageId={message.id} att={att} />
        ) : (
          // A burst whose recording never uploaded: the words still landed, and
          // they were always the point. The glyph says where they came from.
          <span className="ch-voice-noaudio" title="Said out loud; the recording did not survive">
            <Radio className="w-3 h-3" />
          </span>
        )}
        <span className="ch-voice-text">{transcript || <span className="ch-voice-waiting">no words</span>}</span>
        <VoiceClock messageId={message.id} durationMs={message.voice?.durationMs} />
      </div>
    </div>
  );
}
