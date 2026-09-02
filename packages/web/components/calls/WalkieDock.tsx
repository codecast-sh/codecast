// The walkie's own surface, and the reason the call dock has a second shape.
//
// A burst puts you in a real call room, so the ordinary dock would appear for
// every three seconds of someone's voice: a 320x250 floating window with a
// video grid and a hang-up button, for a sentence. That is the wrong weight,
// and two floating surfaces at once would be worse. So while the walkie owns
// the room, THIS is the dock: one strip that says who is talking, shows the
// words as they arrive, and offers what anybody wants next.
//
// WHAT IT OFFERS IS THE WHOLE UPGRADE. A burst and a call are the same room —
// the difference is only whether somebody decided to be in it — so stepping in
// is one button rather than a second surface: Join live, and the strip becomes
// the call dock in place, same seat, same open microphone, nothing torn down.
// Beside it, Snooze, because the answer to a voice arriving is as often "not
// now" as it is "yes"; and the key itself, to talk back without joining
// anything at all.
//
// IT IS THE SIZE OF WHAT IT IS SAYING. A voice arriving out of nowhere is the
// biggest interruption this product makes, and it was answered by a 380px strip
// with a 26px face and 12px words: a notification about a conversation rather
// than the conversation. It is 420px now, the face is 56px and carries the
// talker's own level, the words are 15px, and the two answers are full width
// buttons instead of chips in a row. Nobody should have to look for what to do
// about a voice in their room.
//
// AND IT HAS TO SAY THAT THE MICROPHONE IS OPEN. Auto-listen is hot now:
// hearing a teammate means they can hear you. That is the founder's decision
// and it is the one thing on this screen a person must never meet by accident,
// so it takes the top line with Mute in the same breath. A seat with no
// microphone at all is the honest opposite: nothing to mute, and the headline
// says so in words (hooks/useWalkie walkieStripState).
//
// The markup is split from the wiring on purpose. WalkieStripView is every
// state this surface has, as props, with no store and no engine behind it — so
// each of them renders as static markup and is pinned against the real
// stylesheet (components/__tests__/walkieStrip.test.tsx). WalkieBanner is the
// half that knows where those props come from.
import { useCallback, useSyncExternalStore, type ReactNode, type RefCallback } from "react";
import { BellOff, MessageSquare, MicOff, PictureInPicture2, Square, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { setMuted } from "../../lib/calls/callManager";
import { popOutCall } from "../../lib/calls/popOutCall";
import { canPopOutCall } from "../../lib/desktop";
import { endBurst, endWalkie, getWalkieStatus, joinWalkieLive, shutWalkieDoor, walkieJoinedRoom } from "../../lib/calls/walkie";
import { getJoinAnnouncement, joinTitle, subscribeJoinAnnouncement } from "../../lib/calls/joinAnnounce";
import {
  lastWalkieTarget,
  useWalkieLevelVar,
  useWalkieStatus,
  walkieStripState,
  type WalkieStage,
} from "../../hooks/useWalkie";
import { useChatMessageRow } from "../../hooks/useChatSync";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { memberAvatarUrl, memberDisplayName } from "../../lib/liveEntities";
import { useRoomDescription } from "../../hooks/useCallRoom";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { Avatar } from "./CallStage";
import { WalkiePttButton } from "./WalkiePtt";
import "./walkie.css";

const api = _api as any;

/** How long the snooze shuts the door for. An hour is the honest unit of
 *  "leave me alone": long enough to finish a thing, short enough that nobody
 *  has to remember they pressed it. */
const SNOOZE_MS = 60 * 60 * 1000;

/** How long the strip's last word stays after the seat has gone back. Three
 *  seconds is a sentence read once, without hurry. */
const SNOOZE_NOTE_MS = 3_000;

/** How much of a live transcript the strip carries. It is a tail, not the
 *  message: the message is in the DM, and this is only enough to know whether
 *  to answer. The stylesheet clamps it to two lines on top of this, so the
 *  budget is generous and the box is what really decides. */
const TAIL = 160;

/** The talker's face. 56px, because this is the first thing the eye lands on
 *  when a voice arrives and a name is a slower way to answer "who". */
const FACE = 56;

export function WalkieBanner() {
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
    // And whether there is a microphone at all. A refused device is what turns
    // "Riley is talking" into "you can hear Riley, your mic is off" — the strip
    // must repaint on it rather than wait for the next unrelated push.
    (st: any) => st.call.micDenied,
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
  const snoozedUntil = Number(
    (otherId ? (s.teamMembers ?? []).find((m: any) => String(m?._id) === otherId) : null)
      ?.walkie_snoozed_until ?? 0,
  );
  // Coarse on purpose: an hour-long shutter running out mid-burst is the only
  // thing this clock is for, and a minute of slack at its edge costs nobody.
  const now = useNowWhen((n) => (snoozedUntil > n ? "shut" : "open"), 30_000);
  // THE JOIN, FOR THE FOUR SECONDS IT IS NEWS, and this surface sees it first:
  // the far side's stamp lands while the strip is still on screen and the dock
  // only takes over once the morph is done. Without this the biggest moment in
  // the walkie happened entirely inside a crossfade. The same announcement the
  // dock reads, so the two cannot word it differently (lib/calls/joinAnnounce).
  const announcement = useSyncExternalStore(subscribeJoinAnnouncement, getJoinAnnouncement, () => null);
  // The words, from the burst's own row rather than from the channel store.
  const words = useLiveWords(incoming?.messageId);
  // THE LATCH, read before the face hooks so their inputs are unconditional:
  // locked here means this client is deliberately live in the target's room,
  // and the other person's face belongs on screen even between their bursts.
  const lockedHere = !!target && walkieJoinedRoom(getWalkieStatus()) === target.roomKey;
  const face = useTalkerFace(
    incoming?.fromUserId ?? (lockedHere ? otherId : undefined),
    incoming?.fromName ?? label,
  );
  // The cool ring around that face rises and falls with the voice inside it,
  // written straight onto the element as `--level` by the engine's meter. No
  // React render per frame: the same machinery the key's own ring uses.
  const faceRef = useWalkieLevelVar<HTMLSpanElement>(!!incoming, incoming?.fromUserId);
  // My own circle: on screen whenever my voice is going out. The image comes
  // off the user doc as two scalars, never the row — same discipline as the
  // talker's face above.
  const myImage = useInboxStore(
    (st: any) => st.currentUser?.image || st.currentUser?.github_avatar_url || undefined,
  );
  const myName = useInboxStore((st: any) => String(st.currentUser?.name ?? "You"));
  const myFaceRef = useWalkieLevelVar<HTMLSpanElement>(!!sending);
  if (!target) return null;

  // The teammate's own name when they are the one talking, and the room's label
  // otherwise — which keeps naming a renamed teammate correctly, live, instead
  // of freezing whatever they were called when the burst started.
  const name = incoming?.fromName ?? label;
  // WHAT THE STRIP IS SAYING, decided in one place (hooks/useWalkie's
  // walkieStripState) and drawn here. Every claim on this surface is about
  // somebody's open microphone and every one of them can be false in a way the
  // person only learns from a silence, so the words and the facts live beside
  // the two other rules that read the same world rather than inside a
  // component.
  const strip = walkieStripState(status, s, { name, now });
  const headline = joinTitle(announcement, target.roomKey, Date.now(), strip.headline);

  // No portal and no placement: the strip is one of the contents of the call
  // surface root (components/calls/CallSurfaceRoot), which owns the corner, the
  // width and the morph between this card and the dock's. Rendering itself
  // somewhere else is what used to make the upgrade a swap of two surfaces.
  return (
    <WalkieStripView
      name={name}
      headline={headline}
      words={words}
      face={face}
      faceRef={faceRef}
      myFace={{ image: myImage, name: myName }}
      myFaceRef={myFaceRef}
      stage={strip.stage}
      badge={strip.badge}
      hint={strip.hint}
      tx={strip.tx}
      rx={strip.rx}
      locked={strip.locked}
      together={strip.together}
      muted={strip.locked && s.call.muted !== false}
      hotMic={strip.hotMic}
      micDenied={strip.micDenied}
      quiet={strip.quiet}
      joined={headline !== strip.headline}
      // THE TWO ANSWERS BELONG TO AN ARRIVING VOICE. While only my own key is
      // down there is nothing to step into that I am not already in, and the
      // row would only make the strip taller mid-hold. Both keys down is the
      // opposite case: somebody is talking to me, and joining is exactly what
      // that moment is for.
      // …and never while the join is being announced: the question this row
      // asks has just been answered, and the dock is a moment away.
      actions={(!strip.tx || strip.rx) && headline === strip.headline && !strip.locked}
      onMute={() => void setMuted(true)}
      onMuteToggle={() => void setMuted(s.call.muted === false)}
      onStop={() => void endBurst()}
      // THE CALL, AS CIRCLES OVER THE WORK: the founder's picture of a voice
      // call. Only where the shell can make a see-through window.
      onFloat={canPopOutCall() ? () => void popOutCall({ size: "speaker" }) : undefined}
      onJoin={() => void joinWalkieLive(target.roomKey, { name })}
      onSnooze={snoozeWalkie}
      onOpenDm={() => router.push(`/chat/${target.channelId}`)}
      onLeave={() => void endWalkie()}
      replyKey={
        <WalkiePttButton
          roomKey={target.roomKey}
          resolveChannelId={() => target.channelId}
          size="lg"
          label="Talk back"
          title="Talk back — click to start, click again to stop"
        />
      }
    />
  );
}

/**
 * SNOOZE, and the second it takes to say so.
 *
 * Three things at once, and the order is the promise: the microphone closes,
 * the seat goes back — which is what actually stops the voice, since muting
 * only stops mine — and the hour is written to the server so the door stays
 * shut across every window and every reload. The message is untouched:
 * snoozing mutes a speaker, it never silences one, and the burst still lands in
 * the DM with its unread.
 *
 * The confirmation cannot live in the strip. Handing the seat back is what
 * takes the strip off the screen, so a farewell rendered inside it would be
 * unmounted by the action it is confirming: the dock owns this surface's
 * lifetime (components/calls/CallDock) and by design it ends the moment the
 * room does. So the last line is a toast carrying the strip's own markup —
 * same corner, same stylesheet, three seconds, gone.
 */
function snoozeWalkie(): void {
  const until = Date.now() + SNOOZE_MS;
  useInboxStore.getState().snoozeWalkie(until);
  void setMuted(true);
  shutWalkieDoor();
  toast.custom(() => <WalkieSnoozedNote until={until} />, {
    duration: SNOOZE_NOTE_MS,
    unstyled: true,
  });
}

/**
 * THE STRIP, as markup and nothing else.
 *
 * No store, no engine and no hooks beyond what the caller hands it: every state
 * this surface has is a combination of these props, which is what lets each of
 * them be rendered alone and checked against the stylesheet that draws it.
 */
export function WalkieStripView(props: {
  name: string;
  /** The loud word, the sentence, and what the hands do next — all from
   *  walkieStageWords, so this surface decides nothing about them. */
  stage: WalkieStage;
  badge: string;
  hint: string;
  headline: string;
  /** The live transcript tail. Empty until the recognizer says something. */
  words: string;
  face: { image?: string; name: string } | null;
  /** Writes `--level` onto the face while a voice is inside it. */
  faceRef?: RefCallback<HTMLSpanElement>;
  /** This client's own face — on screen whenever their voice is going out (a
   *  hold, or the latch), popping in the moment it starts. */
  myFace?: { image?: string; name: string } | null;
  /** Writes `--level` onto my face while my mic is open. */
  myFaceRef?: RefCallback<HTMLSpanElement>;
  /** This client is talking. */
  tx: boolean;
  /** A teammate's burst is playing here. */
  rx: boolean;
  /** Deliberately live, hands off the key — the fill locked, or Join live. */
  locked: boolean;
  /** The other side is in too: both faces, one room. */
  together: boolean;
  muted: boolean;
  hotMic: boolean;
  micDenied: boolean;
  quiet: boolean;
  /** The headline is the four second join announcement. */
  joined: boolean;
  /** Join live and Snooze are on offer. */
  actions: boolean;
  onMute: () => void;
  onMuteToggle?: () => void;
  /** Stop my own talk — the toggle's second click, on the card itself. */
  onStop?: () => void;
  /** Float the call as circles over the work. Absent where the shell cannot. */
  onFloat?: () => void;
  onJoin: () => void;
  onSnooze: () => void;
  onOpenDm: () => void;
  onLeave: () => void;
  replyKey?: ReactNode;
}) {
  const { tx, rx, locked, together } = props;
  // WHOSE CIRCLES ARE ON SCREEN. Mine whenever my voice is going out — the
  // press, and the latch after it. Theirs whenever theirs is coming in, or
  // they are deliberately in the room. Both is the founder's picture: two
  // faces, one room, each side seeing the other.
  const showMe = (tx || locked) && !!props.myFace;
  const showThem = (rx || together || (!tx && !locked)) && !!props.face;
  // NEVER THE SAME NAME TWICE. Every sentence the engine writes names the
  // person in it ("Riley is talking", "You and Riley are both talking"), so a
  // name line above it would stutter on every ordinary state. It appears for
  // the sentences that do not, and the sentence carries the weight otherwise.
  const showName = !props.headline.includes(props.name);
  return (
    <div
      className={[
        "walkie-strip",
        tx || rx || locked ? "walkie-strip-live" : "",
        // Both at once is one room with a voice going each way, so both edges
        // are drawn rather than one of them winning.
        tx || locked ? "walkie-strip-tx" : "",
        rx ? "walkie-strip-rx" : "",
        locked ? "walkie-strip-locked" : "",
        props.hotMic ? "walkie-strip-hot" : "",
        props.micDenied ? "walkie-strip-denied" : "",
        props.joined ? "walkie-strip-joined" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* THE STATE, IN ONE LOUD WORD. Read first, from across the room:
          RECORDING, LIVE, ON THE LINE, INCOMING. The sentence and the hint
          under the face say the rest. */}
      <div className={`walkie-stage walkie-stage-${props.stage}`} role="status" aria-live="polite">
        <span className="walkie-stage-dot" aria-hidden="true" />
        <span className="walkie-stage-badge">{props.badge}</span>
        <span className="walkie-stage-with">
          {props.stage === "open" || props.stage === "incoming" ? "" : "with "}
          {props.stage === "open" || props.stage === "incoming" ? "" : props.name}
        </span>
      </div>

      {props.hotMic && <HotMicLine name={props.name} onMute={props.onMute} />}

      <div className="walkie-strip-head">
        {(showMe || showThem) && (
          <span className="walkie-strip-faces" aria-hidden="true">
            {showMe && props.myFace && (
              <span
                ref={props.myFaceRef}
                // Keyed so leaving and re-entering the screen pops again: the
                // pop is the news of a voice starting, not a mount artifact.
                key="me"
                className={`walkie-strip-face walkie-strip-face-tx walkie-face-pop${props.muted ? " walkie-strip-face-muted" : ""}`}
              >
                <Avatar m={{ user_image: props.myFace.image, user_name: props.myFace.name }} size={FACE} />
                {props.muted && (
                  <span className="walkie-strip-face-mutebadge">
                    <MicOff className="h-3 w-3" />
                  </span>
                )}
              </span>
            )}
            {showThem && props.face && (
              <span ref={props.faceRef} key="them" className="walkie-strip-face walkie-face-pop">
                <Avatar m={{ user_image: props.face.image, user_name: props.face.name }} size={FACE} />
              </span>
            )}
          </span>
        )}
        <div className="walkie-strip-who">
          {showName && <div className="walkie-strip-name">{props.name}</div>}
          {/* A teammate's voice arriving is the one thing here that happens TO
              you rather than because of you, and it was announced only by the
              sound and the strip appearing. Polite, not assertive: it is worth
              saying, and never worth cutting somebody off mid-sentence to say. */}
          <div
            className={`walkie-strip-headline ${showName ? "" : "walkie-strip-headline-lead"}`}
            role="status"
            aria-live="polite"
          >
            {props.headline}
          </div>
        </div>
        <div className="walkie-strip-tools">
          <button
            type="button"
            className="walkie-strip-icon"
            aria-label="Open the chat with them"
            title="Open the chat with them — every burst is there as a message"
            onClick={props.onOpenDm}
          >
            <MessageSquare className="h-4 w-4" />
            <span className="walkie-strip-icon-word">Chat</span>
          </button>
          {/* Locked, the red End below is the one door; a second X up here
              would be the same door with a different name. */}
          {!locked && (
            <button
              type="button"
              className="walkie-strip-icon"
              aria-label="Close this and leave the room"
              title="Close this and leave the room"
              onClick={props.onLeave}
            >
              <X className="h-4 w-4" />
              <span className="walkie-strip-icon-word">Close</span>
            </button>
          )}
        </div>
        {/* Talking back without joining anything: the walkie, still. Beside
            the face rather than in the button row, because it is a different
            kind of thing from the two decisions below — a hold, not a click —
            and because while both keys are down this is where my own warm
            ring sits against their cool one. Not while locked: the mic is
            already open on purpose, and a hold-to-reply next to it would be a
            second way to do what is already happening. */}
        {props.replyKey && !locked && !(tx && !rx) && <div className="walkie-strip-reply">{props.replyKey}</div>}
      </div>

      {!!props.words && (
        <div className="walkie-strip-words" title={props.words}>
          {props.words}
        </div>
      )}
      {props.quiet && <div className="walkie-strip-quiet">recording, no live words</div>}

      {/* WHAT YOUR HANDS DO NEXT. Blunt on purpose: every claim on this card
          is about an open microphone, and nobody should have to guess what
          letting go, or pressing a button, will do. */}
      <div className="walkie-strip-hint">{props.hint}</div>

      {/* TALKING: the one control a talk needs, full width. The face menu that
          started it may be under this card by now; Stop lives here too. */}
      {tx && !locked && props.onStop && (
        <div className="walkie-strip-actions">
          <button type="button" className="walkie-strip-stop" onClick={props.onStop}>
            <Square className="h-4 w-4" />
            Stop talking
          </button>
        </div>
      )}

      {/* LOCKED: the two controls a live seat needs, full width and unmissable
          — this is an open microphone with nobody's hand on it, so what stops
          it must never need looking for. Mute is the pause, End is the door. */}
      {locked && (
        <div className="walkie-strip-actions">
          <button
            type="button"
            className={`walkie-strip-mute${props.muted ? " walkie-strip-mute-on" : ""}`}
            onClick={props.onMuteToggle}
          >
            <MicOff className="h-4 w-4" />
            {props.muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" className="walkie-strip-end" onClick={props.onLeave}>
            <X className="h-4 w-4" />
            End — hang up
          </button>
          {props.onFloat && (
            <button
              type="button"
              className="walkie-strip-float"
              onClick={props.onFloat}
              title="Float the call as face circles over your work"
            >
              <PictureInPicture2 className="h-4 w-4" />
              Float faces over my work
            </button>
          )}
        </div>
      )}

      {props.actions && (
        <div className="walkie-strip-actions">
          {/* THE UPGRADE, and the reason this strip exists. Warm, because warm
              is this client's own voice going out everywhere else on this
              surface and that is exactly what pressing it does: the
              microphone that is already open stops carrying a burst and
              starts carrying a conversation. */}
          <button type="button" className="walkie-strip-join" onClick={props.onJoin}>
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
            onClick={props.onSnooze}
          >
            <BellOff className="h-4 w-4" />
            Snooze 1h
          </button>
        </div>
      )}
    </div>
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
 * this burst simply goes back to being something you listen to. A seat that
 * never had a microphone draws nothing here — there is no open mic to warn
 * about, and the headline already says so in words.
 */
function HotMicLine({ name, onMute }: { name: string; onMute: () => void }) {
  return (
    <div className="walkie-hot">
      <span className="walkie-hot-dot" aria-hidden="true" />
      <span className="walkie-hot-text" role="status" aria-live="polite">
        Your mic is open, {name} can hear you
      </span>
      <button type="button" className="walkie-hot-mute" onClick={onMute}>
        <MicOff className="h-3.5 w-3.5" />
        Mute
      </button>
    </div>
  );
}

/** The strip's last line, after the seat has gone back. Carried by a toast
 *  rather than by the strip, for the reason in `snoozeWalkie` above. */
export function WalkieSnoozedNote({ until }: { until: number }) {
  const clock = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="walkie-strip walkie-strip-note">
      <span className="walkie-strip-note-text">Snoozed until {clock}. The message is in the DM.</span>
    </div>
  );
}

/**
 * THE LIVE WORDS, FROM THE BURST AND NOT FROM THE CHANNEL.
 *
 * They used to come from the chat store, which syncs per OPEN channel — so the
 * strip showed words only when the DM behind the burst happened to be on
 * screen, which is the one case where the person could already read them.
 * Every other time a voice arrived out of nowhere and the surface built to
 * answer "what are they saying" said nothing at all.
 *
 * So the burst's own row is subscribed for exactly as long as it is playing:
 * one document, live, ending when the burst does. Not through the standing
 * burst watcher (chat.listLiveVoiceBursts), which deliberately carries no
 * transcript because it re-runs a scan across every DM this client watches and
 * a word arriving must not cost that.
 *
 * The store row is still read, and still first: when the DM IS open it is
 * already there and paints in the same frame, ahead of the subscription's first
 * answer. The longer of the two is the newer one, because a transcript only
 * grows.
 */
function useLiveWords(messageId: string | undefined): string {
  const stored = (useChatMessageRow(messageId)?.content ?? "").trim();
  const { data } = useQueryNoThrow(api.chat.getMessage, messageId ? { message_id: messageId } : "skip");
  const live = String(data?.message?.content ?? "").trim();
  const text = live.length >= stored.length ? live : stored;
  // Cut from the FRONT. The newest words are the ones worth reading, and an
  // ellipsis at the start says plainly that a sentence began before this.
  return text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
}

/**
 * Whoever is talking, from the live roster this client already has.
 *
 * Subscribed as the two scalars it renders rather than as the member row.
 * `teamMembers` is replaced wholesale on every push, so a selector returning
 * the row itself hands back a new reference on every heartbeat in the team and
 * re-renders this on all of them — for an avatar that did not change.
 */
function useTalkerFace(
  userId: string | undefined,
  name: string,
): { image?: string; name: string } | null {
  const find = useCallback(
    (st: any) => (st.teamMembers ?? []).find((m: any) => String(m?._id) === String(userId)),
    [userId],
  );
  const image = useInboxStore((st: any) => memberAvatarUrl(find(st)));
  const displayName = useInboxStore((st: any) => memberDisplayName(find(st), name));
  return userId ? { image, name: displayName } : null;
}
