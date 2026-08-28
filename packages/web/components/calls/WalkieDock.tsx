// The walkie's own surface, and the reason the call dock has a second shape.
//
// A burst puts you in a real call room, so the ordinary dock would appear for
// every three seconds of someone's voice: a 320x250 floating window with a
// video grid and a hang-up button, for a sentence. That is the wrong weight,
// and two floating surfaces at once would be worse. So while the walkie owns
// the room, THIS is the dock: one compact strip that says who is talking, shows
// the words as they arrive, and offers what anybody wants next.
//
// WHAT IT OFFERS IS THE WHOLE UPGRADE. A burst and a call are the same room —
// the difference is only whether somebody decided to be in it — so stepping in
// is one button rather than a second surface: Join live, and the strip becomes
// the call dock in place, same seat, same open microphone, nothing torn down.
// Beside it, Snooze, because the answer to a voice arriving is as often "not
// now" as it is "yes"; and the key itself, to talk back without joining
// anything at all.
//
// AND IT HAS TO SAY THAT THE MICROPHONE IS OPEN. Auto-listen is hot now:
// hearing a teammate means they can hear you. That is the founder's decision
// and it is the one thing on this screen a person must never meet by accident,
// so it takes the top line with Mute in the same breath.
//
// The moment it stops being a walkie and becomes a huddle is `joinedLive`, not
// the mute. The mute used to be the test and could not stay one — every
// listener's mic is open now, so it says who can be heard and nothing at all
// about whether a conversation started (hooks/useWalkie, ct-46032).
import { createPortal } from "react-dom";
import { BellOff, MessageSquare, MicOff, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { leaveCall, setMuted } from "../../lib/calls/callManager";
import { joinWalkieLive, shutWalkieDoor } from "../../lib/calls/walkie";
import { lastWalkieTarget, senderHearingFrom, useWalkieStatus, walkieBurstDropped } from "../../hooks/useWalkie";
import { useChatMessageRow } from "../../hooks/useChatSync";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { memberAvatarUrl, memberDisplayName } from "../../lib/liveEntities";
import { useRoomDescription } from "../../hooks/useCallRoom";
import { useNowWhen } from "../../hooks/useCoarseNow";
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

export function WalkieBanner({
  leaving = false,
  onLeft,
}: { leaving?: boolean; onLeft?: () => void } = {}) {
  const status = useWalkieStatus();
  const router = useRouter();
  const incoming = status.incoming;
  const sending = status.sending;
  // During the linger there is no burst to read the room off, so the walkie's
  // remembered conversation carries the strip through the quiet.
  const target = incoming ?? sending ?? lastWalkieTarget();
  // The room's own description names the other person in a DM, which is how
  // the strip knows whose seat to look for below.
  const { label, otherIds } = useRoomDescription(target?.roomKey ?? null);
  const otherId = otherIds?.[0] ? String(otherIds[0]) : "";
  // Scalars and signatures, never collections: a strip mounted on every page
  // must not wake for a heartbeat in a room it is not reading. `muted` earns
  // its place because with a hot microphone it is the difference between the
  // two things this strip says loudest, and muting has to paint in the same
  // tick as the click.
  const s = useTrackedStore([
    (st: any) => st.call.roomKey,
    (st: any) => st.call.phase,
    (st: any) => st.call.muted,
    (st: any) => String(st.currentUser?._id ?? ""),
    // WHO IS ACTUALLY IN THE ROOM, as a signature of the seats alone. The
    // roster re-pushes on every mute, camera and heartbeat move; none of those
    // change the answer this strip reads off it.
    (st: any) =>
      ((target?.roomKey && st.callOccupancy?.[target.roomKey]) || [])
        .map((m: any) => String(m.user_id))
        .sort()
        .join("|"),
    // And their door, which decides between "away" and "busy".
    (st: any) => {
      const m = otherId
        ? (st.teamMembers ?? []).find((x: any) => String(x?._id) === otherId)
        : null;
      return m ? `${m.status ?? ""}:${m.walkie_pref ?? ""}:${m.walkie_snoozed_until ?? 0}` : "";
    },
  ]);
  const call = s.call;
  const snoozedUntil = Number(
    (otherId ? (s.teamMembers ?? []).find((m: any) => String(m?._id) === otherId) : null)
      ?.walkie_snoozed_until ?? 0,
  );
  // Coarse on purpose: an hour-long shutter running out mid-burst is the only
  // thing this clock is for, and a minute of slack at its edge costs nobody.
  const now = useNowWhen((n) => (snoozedUntil > n ? "shut" : "open"), 30_000);
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
          ? // NOT "Live to X". That claim was made off this client's own seat —
            // my track reached the room — and it was false every time X was
            // away, busy, or had the door shut, which are the cases the walkie
            // exists to survive. The roster is the only thing that knows, and
            // the away tick fires off this same derivation so the words and the
            // sound cannot say different things.
            senderHearingFrom(s, sending.roomKey, now).text
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
    <div
      className={`walkie-strip-host ${leaving ? "walkie-strip-leaving" : ""}`}
      onAnimationEnd={leaving ? onLeft : undefined}
    >
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

        {/* Nothing while our own key is down: the reply to a burst you are
            still speaking is the same burst, and there is nothing to step into
            that we are not already in. The ROW goes rather than its contents —
            an empty row is still a row, and it made the strip taller mid-hold
            than it is at rest. */}
        {!sending && (
          <div className="walkie-strip-actions">
            {/* THE UPGRADE, and the reason this strip exists. It is the only
                violet on a surface that is deliberately warm and cool
                everywhere else, because violet is what calls are — pressing it
                is the moment a burst becomes one. */}
            <button
              type="button"
              className="walkie-strip-join"
              onClick={() => void joinWalkieLive(target.roomKey, { name })}
            >
              Join live
            </button>
            {/* And the honest opposite of it. The answer to a voice arriving is
                as often "not now" as it is "yes", and with a hot microphone
                that answer has to be reachable in the same glance rather than
                in a settings page. */}
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
            {/* Talking back without joining anything: the walkie, still. */}
            <WalkiePttButton
              roomKey={target.roomKey}
              resolveChannelId={() => target.channelId}
              size="md"
              title="Hold to reply"
            />
          </div>
        )}
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

/**
 * Whoever is talking, from the live roster this client already has.
 *
 * Subscribed as the two scalars it renders rather than as the member row.
 * `teamMembers` is replaced wholesale on every push, so a selector returning
 * the row itself hands back a new reference on every heartbeat in the team and
 * re-renders this on all of them — for an avatar that did not change.
 */
function TalkerFace({ userId, name }: { userId: string; name: string }) {
  const find = (st: any) => (st.teamMembers ?? []).find((m: any) => String(m?._id) === String(userId));
  const image = useInboxStore((st: any) => memberAvatarUrl(find(st)));
  const displayName = useInboxStore((st: any) => memberDisplayName(find(st), name));
  return (
    <span className="walkie-strip-face">
      <Avatar m={{ user_image: image, user_name: displayName }} size={26} />
    </span>
  );
}
