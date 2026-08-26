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
import { BellOff, MessageSquare, MicOff, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { leaveCall, setMuted } from "../../lib/calls/callManager";
import { joinWalkieLive, shutWalkieDoor } from "../../lib/calls/walkie";
import { lastWalkieTarget, useWalkieStatus, walkieBurstDropped } from "../../hooks/useWalkie";
import { useChatMessageRow } from "../../hooks/useChatSync";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { memberAvatarUrl, memberDisplayName } from "../../lib/liveEntities";
import { useRoomDescription } from "../../hooks/useCallRoom";
import { Avatar } from "./CallStage";
import { WalkieLevelBars, WalkiePttButton } from "./WalkiePtt";
import "./walkie.css";

/** How long the snooze shuts the door for. An hour is the honest unit of
 *  "leave me alone": long enough to finish a thing, short enough that nobody
 *  has to remember they pressed it. */
const SNOOZE_MS = 60 * 60 * 1000;

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

export function WalkieBanner({ leaving = false }: { leaving?: boolean } = {}) {
  const status = useWalkieStatus();
  const router = useRouter();
  // Three scalars, so a strip mounted on every page cannot be woken by anything
  // but the seat it actually reads. `muted` earns its place now: with a hot
  // microphone it is the difference between the two things this strip says
  // loudest, and muting has to paint in the same tick as the click.
  const s = useTrackedStore([
    (st: any) => st.call.roomKey,
    (st: any) => st.call.phase,
    (st: any) => st.call.muted,
  ]);
  const call = s.call;
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
  // THE ROOM CAN GO AWAY UNDER AN OPEN MICROPHONE, and this used to keep
  // saying "Live to Jordan Lee" through it — measured by disconnecting a live
  // room mid-hold: the key went to `dropped` and said so, and the strip, the
  // surface mounted on every page for exactly the person who is NOT looking at
  // the key, went on claiming a listener who had gone. `heardLive` only ever
  // meant the track reached the room once; the present-tense question is
  // walkieBurstDropped, which the key already asks.
  //
  // It is not a failure and the words do not say so: the recorder is still
  // running, the recognizer is still working, and the burst still lands as a
  // message. What is lost is the live half, and only that.
  const dropped = walkieBurstDropped(sending, call);
  const headline = sending
    ? !sending.live
      ? `Opening the mic for ${name}`
      : dropped
        ? `Nobody is hearing this — ${name} still gets it`
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

  // MY MICROPHONE IS OPEN AND I DID NOT OPEN IT. The hot auto-listen: hearing
  // a teammate now means they can hear me, which is the founder's decision and
  // the one thing on this screen that a person must never discover by
  // accident. Not while my own key is down — a mic I am holding open is not a
  // surprise — and not once I have muted, where the line would be a lie.
  const hotMic = !sending && !call.muted && call.phase === "connected";

  return createPortal(
    <div className={`walkie-strip-host ${leaving ? "walkie-strip-leaving" : ""}`}>
      <div
        className={`walkie-strip ${incoming || sending ? "walkie-strip-live" : ""} ${
          tone ? `walkie-strip-${tone}` : ""
        } ${hotMic ? "walkie-strip-hot" : ""}`}
      >
        {hotMic && <HotMicLine name={name} />}
        <div className="walkie-strip-head">
          {/* THE FACE, when somebody is talking to me. A voice out of nowhere
              is the thing this strip is for, and a name is a slower way to
              answer "who" than a face is. Only for the incoming side: my own
              face tells me nothing I do not know. */}
          {incoming && <TalkerFace userId={incoming.fromUserId} name={name} />}
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
            aria-label="Open the DM"
            title="Open the DM"
            onClick={() => router.push(`/chat/${target.channelId}`)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
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
              speaking is the same burst, and there is nothing to step into
              that we are not already in. */}
          {!sending && (
            <>
              {/* THE UPGRADE, and the reason this strip exists. It is the only
                  violet on a surface that is deliberately warm and cool
                  everywhere else, because violet is what calls are — pressing
                  it is the moment a burst becomes one. */}
              <button
                type="button"
                className="walkie-strip-join"
                onClick={() => void joinWalkieLive(target.roomKey)}
              >
                Join live
              </button>
              <button
                type="button"
                className="walkie-strip-snooze"
                title="No bursts play here for an hour. They still arrive as messages."
                onClick={() => {
                  useInboxStore.getState().snoozeWalkie(Date.now() + SNOOZE_MS);
                  shutWalkieDoor();
                }}
              >
                <BellOff className="h-3.5 w-3.5" />
                Snooze
              </button>
              <WalkiePttButton
                roomKey={target.roomKey}
                resolveChannelId={() => target.channelId}
                size="md"
                title="Hold to reply"
              />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The line that has to be unmissable.
 *
 * Every join opens the microphone now, the receiver's background listen
 * included — a true walkie, where hearing somebody means they can hear you.
 * That is a good decision and an alarming one to meet by surprise, so it gets
 * the top of the strip, the warm outgoing colour (the mic is going OUT), and
 * the fix in the same breath rather than in a menu.
 *
 * Muting keeps the seat: the burst still plays, the words still arrive, and
 * this burst simply goes back to being something you listen to.
 */
function HotMicLine({ name }: { name: string }) {
  return (
    <div className="walkie-hot">
      <span className="walkie-hot-dot" aria-hidden="true" />
      <span className="walkie-hot-text" role="status" aria-live="polite">
        Your mic is open — {name} can hear you
      </span>
      <button
        type="button"
        className="walkie-hot-mute"
        onClick={() => void setMuted(true)}
      >
        <MicOff className="h-3 w-3" />
        Mute
      </button>
    </div>
  );
}

/** Whoever is talking, from the live roster this client already has. */
function TalkerFace({ userId, name }: { userId: string; name: string }) {
  const member = useInboxStore((st: any) =>
    (st.teamMembers ?? []).find((m: any) => String(m?._id) === String(userId)),
  );
  return (
    <span className="walkie-strip-face">
      <Avatar
        m={{ user_image: memberAvatarUrl(member), user_name: memberDisplayName(member, name) }}
        size={26}
      />
    </span>
  );
}
