// The walkie's own surface, and the reason the call dock has a second shape.
//
// A burst puts you in a real call room — the engine joins it muted so the voice
// comes out of the existing audio host — so the ordinary dock would appear for
// every three seconds of someone's voice: a 320x250 floating window with a
// video grid and a hang-up button, for a sentence. That is the wrong weight,
// and two floating surfaces at once would be worse. So while the walkie owns
// the room, THIS is the dock: one compact strip that says who is talking, shows
// the words as they arrive, and offers the two things anybody wants next —
// answer, or go to the conversation.
//
// The moment it stops being a walkie and becomes a huddle — the person opens
// their own mic — ownership ends and the ordinary dock takes the room back.
// `call.muted` is the test, which is the same signal the engine's linger uses
// to decide the room has become a conversation.
import { createPortal } from "react-dom";
import { MessageSquare, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { leaveCall } from "../../lib/calls/callManager";
import { lastWalkieTarget, useWalkieStatus } from "../../hooks/useWalkie";
import { useChatMessageRow } from "../../hooks/useChatSync";
import { useRoomDescription } from "../../hooks/useCallRoom";
import { WalkieLevelBars, WalkiePttButton } from "./WalkiePtt";
import "./walkie.css";

/** How much of a live transcript the strip carries. It is a tail, not the
 *  message: the message is in the DM, and this is only enough to know whether
 *  to answer. */
const TAIL = 140;

/** The live words, when they happen to be here. Chat messages sync per open
 *  channel, so a burst into a DM nobody has open has no transcript to show and
 *  the strip simply says who is talking — which is what "cheaply available"
 *  has to mean for a surface mounted on every page. */
function LiveTail({ messageId }: { messageId: string }) {
  const row = useChatMessageRow(messageId);
  const text = (row?.content ?? "").trim();
  if (!text) return null;
  return (
    <div className="walkie-strip-tail" title={text}>
      {text.length > TAIL ? `…${text.slice(-TAIL)}` : text}
    </div>
  );
}

export function WalkieBanner() {
  const status = useWalkieStatus();
  const router = useRouter();
  const incoming = status.incoming;
  const sending = status.sending;
  // During the linger there is no burst to read the room off, so the walkie's
  // remembered conversation carries the strip through the quiet.
  const target = incoming ?? sending ?? lastWalkieTarget();
  const { label } = useRoomDescription(target?.roomKey ?? null);
  if (!target) return null;

  // The teammate's own name when they are the one talking, and the room's label
  // otherwise — which keeps naming a renamed teammate correctly, live, instead
  // of freezing whatever they were called when the burst started.
  const name = incoming?.fromName ?? label;
  // THE STRIP SAYS WHICH OF THE TWO TRUE THINGS IS HAPPENING. A burst is kept
  // from the moment the microphone opens and heard from the moment the track
  // reaches the room, and those are seconds apart on a cold room. Saying
  // "talking to Sam" through the gap promised the first thing while only the
  // second was true; now each half gets its own sentence, and neither of them
  // is a failure.
  const headline = sending
    ? !sending.live
      ? `Opening the mic for ${name}`
      : sending.heardLive
        ? `Live to ${name}`
        : `Recording — ${name} gets it`
    : incoming
      ? `${name} is talking`
      : `Still open with ${name}`;
  // A recognizer that is down is a burst without live words, not a failed
  // burst: the audio records, the message lands, and the server recovers the
  // words from the recording afterwards. Saying so is the difference between a
  // blank tail that reads as silence and one that reads as a delay.
  const quiet = sending && status.asr === "unavailable";
  const tone = sending ? "tx" : incoming ? "rx" : null;

  return createPortal(
    <div className="walkie-strip-host">
      <div
        className={`walkie-strip ${incoming || sending ? "walkie-strip-live" : ""} ${
          tone ? `walkie-strip-${tone}` : ""
        }`}
      >
        <div className="walkie-strip-head">
          {/* The meter replaces the dot while somebody is actually talking: the
              dot could only say that a burst existed, and the bars say whether a
              voice is reaching the microphone at all. The dot stays for the
              linger, where there is no voice to measure. */}
          {tone ? (
            <WalkieLevelBars identity={incoming?.fromUserId} tone={tone} />
          ) : (
            <span className="walkie-strip-pulse" aria-hidden="true">
              <span className="walkie-strip-dot" />
            </span>
          )}
          {/* A teammate's voice arriving is the one thing here that happens TO
              you rather than because of you, and it was announced only by the
              sound and the strip appearing. Polite, not assertive: it is worth
              saying, and never worth cutting somebody off mid-sentence to say. */}
          <span className="walkie-strip-name" role="status" aria-live="polite">
            {headline}
          </span>
          <button
            type="button"
            className="walkie-strip-icon"
            aria-label="Leave the room"
            title="Leave the room"
            onClick={() => void leaveCall()}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {incoming && <LiveTail messageId={incoming.messageId} />}
        {quiet && <div className="walkie-strip-quiet">recording, no live words</div>}

        <div className="walkie-strip-actions">
          {/* Not while our own key is down: the reply to a burst you are still
              speaking is the same burst. */}
          {!sending && (
            <WalkiePttButton
              roomKey={target.roomKey}
              resolveChannelId={() => target.channelId}
              size="lg"
              title="Hold to reply"
            />
          )}
          <button
            type="button"
            className="walkie-strip-open"
            onClick={() => router.push(`/chat/${target.channelId}`)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Open the DM
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
