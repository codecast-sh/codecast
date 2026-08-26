// A walkie burst in the chat timeline.
//
// The product argument this renders: THE TRANSCRIPT IS THE MESSAGE. Reading is
// always enough, so the words sit where an ordinary message's words sit, in the
// same type, and the audio is the optional half beside them. That is why there
// is no waveform — a waveform says "you must listen to know what this is", and
// here you never must.
//
// Two states, one row shape, and the direction is the colour — warm when the
// voice going out is yours, cool when it is theirs coming in, the same two
// tokens the key and the strip wear.
//
//   LIVE   the sender is still holding the key. A dot breathes (the same motion
//          the anchor's "thinking" uses, because it means the same thing: words
//          are still arriving), the level bars beside it move with the actual
//          voice, and the transcript grows in place. Clicking joins the room —
//          the burst is being spoken INTO a live call room, and walking into it
//          is the whole "join in if I see it" move.
//   DONE   play, pause, duration, and a hairline under the words while it is
//          playing. The recording is an ordinary attachment, so it resolves
//          through the same storage-url path an image does. A message carrying
//          audio and no `voice` field lands here too: what a row IS is decided
//          by what is attached to it, not by which feature wrote it.
//
// It takes a ChatMessageView and nothing else, so it renders from a fixture the
// way the rest of the chat surface does. The two things it can DO — play a
// recording, walk into a live room — go straight to the module singletons that
// own them, which is what keeps a join handler from being threaded down through
// all four surfaces that mount a timeline.
import { useSyncExternalStore } from "react";
import { Play, Pause, Radio, Loader2 } from "lucide-react";
import { useStorageImageUrl } from "../../hooks/useStorageImageUrl";
import { joinWalkieLive } from "../../lib/calls/walkie";
import { useWalkieStatus, walkieJoinReason } from "../../hooks/useWalkie";
import { WalkieLevelBars } from "../calls/WalkiePtt";
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
// The direction tokens the whole walkie wears, warm out and cool in. A bubble
// is a walkie surface like the key and the strip, so it takes them from the
// same file rather than keeping a second copy of the decision.
import "../calls/walkie.css";

/** The play control, kept in its own component for the same reason
 *  AttachmentTile is: it is the only thing here that resolves a storage url,
 *  and that reaches for the Convex client. A live bubble has no recording yet,
 *  so it must not pay for one.
 *
 *  Exported, because a recording is playable wherever it appears: the message
 *  timeline renders one of these for an audio attachment that arrived beside
 *  other files, where the alternative is the image grid putting a webm in an
 *  <img> — diagnosis 7's actual symptom, and the reason the key is a prop. One
 *  player is shared by the whole app, so two recordings in one message need two
 *  distinct keys. */
export function VoicePlayButton({ playKey, att }: { playKey: string; att: ChatAttachmentView }) {
  const url = useStorageImageUrl(att.storage_id);
  const playback = useSyncExternalStore(
    subscribeVoicePlayer,
    getVoicePlayback,
    getVoicePlaybackServer,
  );
  const mine = playback.key === playKey;
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
      data-walkie-play={playKey}
      onClick={() => url && toggleVoice(playKey, url)}
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

/** How far through the recording the playback is, as a thin line under the
 *  transcript. Only the bubble being played draws one — everywhere else there
 *  is no position to show, and a track at zero would read as a player that had
 *  failed to start.
 *
 *  THE SERVER'S LENGTH FIRST, exactly as the clock beside it does. A walkie
 *  recording is webm/opus written by MediaRecorder, and that container carries
 *  no duration in its metadata — so `el.duration` is Infinity and the player's
 *  own `durationMs` stays zero for every burst this feature produces. Keying
 *  the line on it meant it never drew at all, which is how it was caught: the
 *  transcript said 0:02 and the line under it was missing. */
function VoiceProgress({ messageId, durationMs }: { messageId: string; durationMs?: number }) {
  const playback = useSyncExternalStore(
    subscribeVoicePlayer,
    getVoicePlayback,
    getVoicePlaybackServer,
  );
  const total = durationMs || playback.durationMs;
  if (playback.key !== messageId || !total) return null;
  const done = Math.min(1, playback.positionMs / total);
  return (
    <span
      className="ch-voice-progress"
      aria-hidden="true"
      style={{ ["--p" as string]: done.toFixed(4) }}
    />
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
  // The snapshot is the wake AND, here, the answer to whose burst this is.
  const status = useWalkieStatus();
  // WHICH DIRECTION THIS BUBBLE IS. Asked of the engine rather than of the
  // viewer's id, because the engine knows it exactly: the burst it is sending
  // is this row (under either id — the optimistic one it painted, or the server
  // row that superseded it), or the burst it is hearing is. Warm for your own
  // voice going out, cool for theirs coming in, the same two colours the key
  // and the strip wear.
  const mine =
    !!status.sending &&
    (status.sending.clientId === message.id || status.sending.messageId === message.id);
  const theirs =
    status.incoming?.messageId === message.id ? status.incoming.fromUserId : undefined;
  // A meter needs a voice to measure. A live burst in a DM somebody has open
  // but is not in the room for has neither — the row says it is live and that
  // is all this client knows — so the pulsing dot carries it alone rather than
  // four bars sitting flat, which would say the microphone was dead.
  const metered = mine || !!theirs;
  // The JOIN question, not the push-to-talk one. Clicking a live bubble steps
  // into the room, and being already in it is no reason to refuse: this is the
  // same gesture as the strip's "Join live", reached from the message instead
  // of from the strip, so it opens the mic and stamps the seat the same way —
  // a person who clicks a voice that is still being spoken has decided to talk
  // back, and the sender's surface upgrades on the strength of it.
  const reason = walkieJoinReason(roomKey);

  return (
    <div className="ch-msg-body">
      <button
        type="button"
        className={`ch-voice ch-voice-live ${mine ? "ch-voice-tx" : "ch-voice-rx"}`}
        disabled={!!reason}
        data-walkie-live={message.id}
        title={reason ?? "Join the room and talk back"}
        onClick={() => roomKey && void joinWalkieLive(roomKey)}
      >
        <span className="ch-voice-pulse" aria-hidden="true">
          <span className="ch-voice-dot" />
        </span>
        {metered && <WalkieLevelBars identity={theirs} tone={mine ? "tx" : "rx"} />}
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

  // The live recognizer heard nothing and the server is reading the recording
  // instead. It is a wait, not a loss, and it has to say which: an empty bubble
  // beside a playable recording reads as a burst nobody managed to transcribe,
  // when the words are seconds away.
  const recovering = !!message.voice?.transcribing && !transcript;

  return (
    <div className="ch-msg-body">
      <div className="ch-voice">
        {att ? (
          <VoicePlayButton playKey={message.id} att={att} />
        ) : (
          // A burst whose recording never uploaded: the words still landed, and
          // they were always the point. The glyph says where they came from.
          <span className="ch-voice-noaudio" title="Said out loud; the recording did not survive">
            <Radio className="w-3 h-3" />
          </span>
        )}
        <span className="ch-voice-body">
          <span className="ch-voice-text">
            {recovering ? (
              <span className="ch-voice-waiting">
                <Loader2 className="ch-voice-spinner" aria-hidden="true" />
                getting the words
              </span>
            ) : (
              transcript || <span className="ch-voice-waiting">no words</span>
            )}
          </span>
          {/* Where the playback has got to, for the one bubble being played. */}
          <VoiceProgress messageId={message.id} durationMs={message.voice?.durationMs} />
        </span>
        <VoiceClock messageId={message.id} durationMs={message.voice?.durationMs} />
      </div>
    </div>
  );
}
