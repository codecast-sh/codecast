// The walkie talkie: hold a key, talk, and the words land in the DM.
//
// A burst is three things happening at once on ONE mic track. The audio goes
// live into the DM's call room, so a teammate who is at their desk hears it as
// it is spoken. The same track is recorded locally, so the message is playable
// afterwards by everyone who was not. And the same track feeds one recognizer
// (lib/calls/asrPipe — the unit the huddle scribe is built from), so the DM
// carries the words while they are still being said. The chat message is the
// spine of all three: chat.startVoiceBurst opens it live, appendVoiceTranscript
// streams the text into it, finalizeVoiceBurst lands it with the recording.
//
// Module singleton beside callManager and transcription, same contract:
// subscribe/getSnapshot for a small status object, MediaStreamTracks never
// enter the store, and the only store writes are the burst's own optimistic
// bubble through chatSlice actions.
//
// WHO OWNS THE ROOM. callManager does, always. The walkie asks it to join, to
// mute and to leave; it never touches the Room itself. That is also why walkie
// is UNAVAILABLE while the user is in another huddle: hijacking a live call to
// shout into a DM would be a media-plane fight nobody asked for, so the status
// says so instead and the UI disables push-to-talk.
//
// WHO OWNS THE MICROPHONE. This module does, and that inversion is what made
// the feature work. Joining the room first and borrowing LiveKit's published
// track put a token mint and an SFU connect between the key going down and
// anything listening — 1.0s warm, 12.7s cold — and everything said in that gap
// reached nobody and landed in no recording, so a two second burst came back as
// "no words". Now getUserMedia comes first, then the recorder, the meter and
// the recognizer on that track, and the room last, carrying a CLONE.
// `sending.live` says the words are being kept; `sending.heardLive` says
// somebody is hearing them right now.
//
// WHICH SURFACE IS ON SCREEN, in two sentences. The walkie holds ONE room at a
// time and knows only what that room is — a burst going out, a burst coming in,
// or a call somebody stepped into on purpose — so `liveRoom` is the single
// fact, and `walkieHoldsRoom` is the whole question a surface asks. A burst or
// a listen draws the strip; a call draws the ordinary dock, and the stage when
// the person expanded it.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Track } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";
import { newChatMessageClientId } from "../../store/chatSlice";
import { getRoom, joinCall, leaveCall, mediaFailureReason, setMuted } from "./callManager";
import { micConstraints, readJoinPrefs } from "./joinPrefs";
import { openAsrPipe, type AsrPipe } from "./asrPipe";
import { uploadBlobToStorage } from "../uploadBlob";
import { mutateOnUnload } from "../keepaliveMutation";
import {
  soundWalkieAway,
  soundWalkieJoined,
  soundWalkieKeyUp,
  soundWalkieOpen,
  soundWalkieRoger,
  soundWalkieSquelch,
} from "../sounds";
import { announceJoin, youJoinedText } from "./joinAnnounce";

const api = _api as any;

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

/** Below this, the key was brushed rather than held: nothing was said.
 *
 *  EXPORTED because the people wall's face is both a hold and a click, and a
 *  click is only safe to let open the microphone because anything this short is
 *  discarded here. Its tap window imports the real number and asserts the gap,
 *  so a hand-copied 700 cannot go quietly stale the day this moves. */
export const MIN_BURST_MS = 700;
// A hard stop on one hold, for product sanity rather than for the server:
// nobody walkie-talks for two minutes, and a key wedged down by a stuck event
// must not record forever. The cap lands the burst as an ordinary message; the
// person presses again if they were not finished.
//
// It is NOT a race against the orphan sweep. The sweep ages a live row by
// updated_at, and the transcript pushes below rewrite that row every couple of
// seconds — so a burst that is still being spoken into keeps itself alive.
const MAX_BURST_MS = 120_000;
/** The window the server sweeps a dead burst at, for ignoring a live row whose
 *  sender's tab died before anyone talked in that room again. */
const BURST_STALE_MS = 120_000;
/** Transcript pushes: a few times a burst, never per word. */
const TRANSCRIPT_PUSH_MS = 2_500;
// A hold with nothing being said still has to say "I am here". The server ages
// a live burst by updated_at, and a silence changes no text — so after this
// long without a write, the same transcript goes again purely to touch the row.
const KEEPALIVE_MS = 45_000;
/** How long the room stays open after a burst, in case someone talks back. */
const LINGER_MS = 30_000;

export type WalkieSending = {
  channelId: string;
  roomKey: string;
  /** The row id the bubble is painted under until the server row supersedes it. */
  clientId: string;
  /** Null until chat.startVoiceBurst answers; the bubble exists either way. */
  messageId: string | null;
  startedAt: number;
  /** The recorder and the recognizer are running on a live microphone: every
   *  word from here on is being KEPT, whatever the room is doing. This is what
   *  a push-to-talk key should light on — it is true within about a tenth of a
   *  second of the press, because nothing but getUserMedia precedes it. */
  live: boolean;
  /** The track reached the room, so a teammate sitting at their desk hears this
   *  as it is spoken. Later than `live`, and that gap is not small: measured at
   *  1.0s into a warm room and 12.7s into a cold one. Nothing said before it
   *  reaches anybody LIVE — but it is recorded and transcribed, and it lands in
   *  the message, so the gap costs immediacy and never words. */
  heardLive: boolean;
  /** When `heardLive` became true; null until then. */
  openAt: number | null;
  transcript: string;
};

export type WalkieIncoming = {
  channelId: string;
  messageId: string;
  roomKey: string;
  fromUserId: string;
  fromName: string;
  /** When the sender's key went down, by the server's clock. Carried because
   *  it is the only thing that can bound a hot listen: the burst's row stops
   *  changing the moment it starts, so age is the one fact that keeps moving
   *  (see the ceiling below). */
  createdAt: number;
};

/**
 * WHAT THE ROOM IS. Three answers, and they are the whole state machine:
 *
 *   burst   — this client's key is down, or the seat is still held open after
 *             it came up in case an answer arrives.
 *   listen  — a teammate's burst is playing here, or the seat is still held
 *             open after it ended.
 *   call    — somebody stepped in on purpose. Mine (joinWalkieLive) or theirs
 *             (a walkie_joined_at stamp landing on the roster).
 *
 * `call` is STICKY for as long as the room lasts: a burst spoken into a room
 * that is already a call stays a call. That is what makes hold-to-reply inside
 * a huddle a non-event rather than a thing to defend against — the walkie is a
 * guest there, implied by the mode rather than recorded in a field of its own.
 */
export type WalkieRoomMode = "burst" | "listen" | "call";

export type WalkieLiveRoom = {
  key: string;
  mode: WalkieRoomMode;
  /** When this client's involvement with this room began. Steady across a
   *  change of mode, because it answers "since when has the walkie been in
   *  here" — which is what tells a fresh join stamp from one a browser that
   *  died left behind. */
  since: number;
};

export type WalkieStatus = {
  /** What this client is transmitting right now. */
  sending: WalkieSending | null;
  /** The teammate this client is currently listening to, live. */
  incoming: WalkieIncoming | null;
  /**
   * THE ROOM THE WALKIE IS IN, and the only thing that decides which surface is
   * on screen. Non-null from the instant of a press — before getUserMedia
   * answers, let alone the room — until the seat is genuinely handed back, so
   * there is no tick in which this client is seated and nothing owns the room.
   * That gap was its own class of bug (ct-46031) and it is now unrepresentable
   * rather than defended.
   */
  liveRoom: WalkieLiveRoom | null;
  /** Why push-to-talk cannot be used; null when it can. */
  unavailable: null | "another-call" | "not-ready";
  /** True when holding the key would answer someone — the reply affordance. */
  canReply: boolean;
  /**
   * Whether live words are coming back from the recognizer, for the most recent
   * burst. A DOWN RECOGNIZER IS NOT A FAILED BURST: the audio still records, the
   * message still lands, and the server transcribes the recording afterwards. So
   * this exists to let a surface say "recording, no live words" instead of
   * showing an empty transcript that reads as silence.
   *
   * It describes the last burst rather than the moment, and is reset to "live"
   * by the next press — so the strip can still explain a burst that has just
   * landed without words.
   */
  asr: "live" | "unavailable";
  error: string | null;
};

let status: WalkieStatus = {
  sending: null,
  incoming: null,
  liveRoom: null,
  unavailable: "not-ready",
  canReply: false,
  asr: "live",
  error: null,
};

const subscribers = new Set<() => void>();

function emit(patch: Partial<WalkieStatus>) {
  const next = { ...status, ...patch };
  next.canReply = !!next.incoming && !next.sending && next.unavailable === null;
  // Snapshot identity is what wakes React; skip the wake when nothing moved.
  if (
    next.sending === status.sending &&
    next.incoming === status.incoming &&
    next.liveRoom === status.liveRoom &&
    next.unavailable === status.unavailable &&
    next.canReply === status.canReply &&
    next.asr === status.asr &&
    next.error === status.error
  ) {
    return;
  }
  status = next;
  for (const cb of subscribers) cb();
}

export function subscribeWalkie(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getWalkieStatus(): WalkieStatus {
  return status;
}

let convex: ConvexHandle | null = null;

/** React binds the live Convex client (hooks/useWalkieSync); until then every
 *  gesture below no-ops and the status reads "not-ready". */
export function bindWalkie(client: ConvexHandle) {
  convex = client;
  // Kept where a hot replacement of this module can find it again (see the
  // bottom of the file). No-op in a build.
  if (import.meta.hot) import.meta.hot.data.walkieConvex = client;
  refresh();
}

// ── where the call plane currently is ───────────────────────────────────────

type CallState = { roomKey: string | null; phase: string; muted: boolean };

function callState(): CallState {
  const call = useInboxStore.getState().call as any;
  return { roomKey: call?.roomKey ?? null, phase: call?.phase ?? "idle", muted: call?.muted !== false };
}

function inRoom(roomKey: string): boolean {
  const call = callState();
  return call.roomKey === roomKey && (call.phase === "connected" || call.phase === "connecting");
}

/** A live call in some OTHER room. The walkie stays out of it. */
function busyElsewhere(roomKey?: string): boolean {
  const call = callState();
  if (!call.roomKey || call.roomKey === roomKey) return false;
  return call.phase === "connected" || call.phase === "connecting" || call.phase === "ringing_out";
}

/**
 * Whether push-to-talk can be used for one specific room, which is the question
 * a DM's mic button actually has. The global `status.unavailable` is this same
 * answer asked about the room the walkie is already occupied with.
 */
export function walkieBlockedFor(roomKey?: string): WalkieStatus["unavailable"] {
  if (!convex) return "not-ready";
  return busyElsewhere(roomKey) ? "another-call" : null;
}

/**
 * ENTER THE ROOM, or change what being in it means. Synchronous, and called
 * from the three gestures that are the only ways in: a press, a teammate's
 * burst starting to play, and somebody stepping in on purpose.
 *
 * A room that is already a `call` stays one. Both halves of that matter: a
 * second burst spoken inside a call must not turn it back into a burst, and a
 * burst spoken into a huddle the person was already sitting in must not take
 * the huddle's own dock away — which is the whole of what a "guest" flag used
 * to record, now implied.
 */
function enterLiveRoom(key: string, mode: WalkieRoomMode): void {
  const held = status.liveRoom?.key === key ? status.liveRoom : null;
  // A room this client was ALREADY SITTING IN is a call, whoever opened it and
  // whatever the walkie is about to do in it. Hold-to-reply inside a huddle is
  // a guest speaking in somebody else's room: the huddle keeps its own dock and
  // its own hang-up, and no timer of ours may ever take its seat. Asked here,
  // once, at the instant of the gesture — the pre-burst world, which is exactly
  // the question a separate `guest` flag used to record an answer to.
  const next: WalkieRoomMode = held?.mode === "call" || (!held && inRoom(key)) ? "call" : mode;
  if (held?.mode === next) return;
  emit({ liveRoom: { key, mode: next, since: held?.since ?? Date.now() } });
}

function leaveLiveRoom(): void {
  if (status.liveRoom) emit({ liveRoom: null });
}

/**
 * THE QUESTION EVERY SURFACE ASKS: is the walkie holding this room, as a burst
 * rather than as a call?
 *
 * Yes means the strip is the surface and the ordinary call dock stands down —
 * a burst joins a room exactly the way a huddle does, so without this the
 * floating call window would open for every sentence anybody says. No means the
 * room is a conversation and belongs to the dock, whether it started as one or
 * became one when somebody pressed Join live.
 *
 * `roomKey` null asks about the walkie alone, which is the honest question
 * while a burst outlives the room it was spoken into: the recorder and the
 * recognizer are still running and the message still lands, so the strip stays
 * even though the call plane has gone idle.
 */
export function walkieHoldsRoom(s: WalkieStatus, roomKey: string | null): boolean {
  const live = s.liveRoom;
  if (!live || live.mode === "call") return false;
  return !roomKey || roomKey === live.key;
}

/** The room somebody stepped into on purpose, for the readers that only ask
 *  that — a face's "joined" badge, the release's "do not mute" rule. */
export function walkieJoinedRoom(s: WalkieStatus): string | null {
  return s.liveRoom?.mode === "call" ? s.liveRoom.key : null;
}

/** Recompute what the UI may offer. Called whenever the world moves. */
function refresh() {
  reconcileLiveRoom();
  emit({ unavailable: walkieBlockedFor(status.liveRoom?.key) });
  reconcileIdleRelease();
}

/**
 * The live room, against where the call plane actually is.
 *
 * ONE RULE FOR THREE THINGS that used to be three: a linger whose room the
 * person walked out of, a join stamp outliving the call it named, and a burst
 * whose room fell over. All of them are the same sentence — the walkie is not
 * in that room any more — and this runs on every move of the call plane
 * (useWalkieSync refreshes on roomKey:phase), so none of them can outlive it.
 *
 * A burst or a listen in flight is exempt, because it OWNS a room the join has
 * not landed in yet: nothing is seated, so there is nothing to be wrong about.
 */
function reconcileLiveRoom(): void {
  const live = status.liveRoom;
  if (!live) return;
  if (burst || status.incoming) return;
  if (!inRoom(live.key)) leaveLiveRoom();
}

// ── the seat's own clock ────────────────────────────────────────────────────
//
// A SEAT NEEDS A CLOCK OF ITS OWN, because nothing else in this path has one,
// and because auto-listen is hot: a burst holds the receiver's microphone open.
//
// One timer, one deadline, derived from the state rather than armed by events.
// That is the difference between this and what it replaces — a linger timer, a
// separate hot-listen ceiling, a `lingerRoomKey`, a `ceilingFor` and three
// cleanup paths, each of which existed to stop one of the others going wrong.
//
// Two deadlines, one at a time:
//
//   A LISTEN gets the burst's own outer bound. What normally ends a listen is
//   the server saying the burst is over, and that push never comes if the
//   sender's tab dies mid-word: the row stays `voice.status: "live"` forever,
//   the sweep runs only as a side effect of the next burst in that channel, and
//   `chat.listLiveVoiceBursts` returns a byte-identical result that wakes
//   nobody. So the receiver counts from the burst's own age instead.
//
//   A HELD ROOM gets half a minute from the last audio in it — my key coming
//   up, or a teammate's burst ending. A burst is one half of a conversation and
//   leaving at once would send the answer to an empty room.
//
// A key in hand holds the room with no clock at all, and so does a call
// somebody stepped into. But a LISTEN'S ceiling runs inside a call too: the
// burst really is over there as well, and the dead row still has to be cleared.
// Handing the seat back is `shouldReleaseRoom`'s decision and it refuses for a
// call, which is what keeps a timer from ever hanging one up.

// Room for a full-length burst to finish and report itself: the sender's own
// cap (MAX_BURST_MS) is the same 120s as the staleness window, so a legitimate
// monologue reaches the line at the very moment it stops, and its upload and
// finalize still have to land after that.
const HOT_LISTEN_SLACK_MS = 30_000;

/** When a hot listen must end whatever the server has said — 2.5 minutes after
 *  the key went down, and the outer bound on any microphone this feature opens
 *  without being asked. */
export function hotListenDeadline(createdAt: number): number {
  return createdAt + BURST_STALE_MS + HOT_LISTEN_SLACK_MS;
}

/** When audio was last in the room: my key coming up, or a teammate's burst
 *  ending. The half minute an answer might arrive in counts from here, so a
 *  two-way exchange holds the seat for as long as it is a conversation. */
let lastAudioAt = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** The deadline the armed timer is for, so re-arming is idempotent. */
let idleAt: number | null = null;

/** When this seat stops being worth holding, or null while something is
 *  holding it. Exported for its test: it IS the rule. */
export function seatDeadline(input: {
  live: WalkieLiveRoom | null;
  bursting: boolean;
  incoming: { createdAt: number } | null;
  lastAudioAt: number;
}): number | null {
  if (!input.live) return null;
  if (input.incoming) return hotListenDeadline(input.incoming.createdAt);
  if (input.live.mode === "call") return null;
  if (input.bursting) return null;
  return input.lastAudioAt + LINGER_MS;
}

function reconcileIdleRelease(): void {
  const at = seatDeadline({
    live: status.liveRoom,
    bursting: !!burst,
    incoming: status.incoming,
    lastAudioAt,
  });
  if (at === idleAt) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleAt = at;
  idleTimer =
    at === null
      ? null
      : // FLOORED rather than clamped at zero: a deadline already in the past
        // must not re-arm at zero and spin the main thread.
        setTimeout(onSeatIdle, Math.max(1_000, at - Date.now()));
}

function onSeatIdle(): void {
  idleTimer = null;
  idleAt = null;
  const live = status.liveRoom;
  if (!live) return;
  // A burst still marked live at this point belongs to a tab that died: no push
  // is coming to end it, and there is nobody left to answer. Dropping it here
  // is what lets the seat go back — and it is right inside a call too, where
  // the release below refuses and only the dead row is cleared.
  if (status.incoming) emit({ incoming: null });
  releaseRoom(live.key);
  refresh();
}

function localMicTrack(): MediaStreamTrack | null {
  const pub = getRoom()?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track?.mediaStreamTrack;
  return track && track.readyState === "live" ? track : null;
}

// ── the microphone ──────────────────────────────────────────────────────────
//
// The walkie holds its own, and the room joins behind it holding a CLONE. A
// clone shares the one capture without sharing its lifetime, so callManager may
// own, mute and stop its copy exactly as it owns every published track, and a
// room closing mid-word cannot truncate the recording.
//
// The track outlives the burst by a minute: the second press is the one that
// has to feel instant, and getUserMedia on an already-granted device is still
// tens of milliseconds of work.

/** How long an unused microphone is held before it is given back. Long enough
 *  to cover a conversation's back-and-forth, short enough that the browser's
 *  recording indicator is not left on after somebody walks away. */
const MIC_IDLE_MS = 60_000;

let mic: MediaStreamTrack | null = null;
let micPending: Promise<MediaStreamTrack | null> | null = null;
let micIdleTimer: ReturnType<typeof setTimeout> | null = null;
/** A press has been granted the microphone at least once in this tab, so
 *  asking again cannot raise a prompt. The Permissions API answers the same
 *  question where it supports "microphone"; this covers the browsers where it
 *  does not. */
let micGranted = false;

function heldMic(): MediaStreamTrack | null {
  if (mic && mic.readyState === "live") return mic;
  mic = null;
  return null;
}

function stopMic() {
  try {
    mic?.stop();
  } catch {}
  mic = null;
}

/** Start the clock on giving the microphone back. A burst in flight keeps it. */
function releaseMicLater() {
  if (micIdleTimer) clearTimeout(micIdleTimer);
  micIdleTimer = setTimeout(() => {
    micIdleTimer = null;
    if (burst) return;
    stopMic();
  }, MIC_IDLE_MS);
}

/** Open the microphone, or hand back the one already open. Concurrent callers
 *  share one getUserMedia — two push-to-talk surfaces under one pointer must
 *  not open two devices. */
// Why the last acquire failed, kept because the caller needs it to say
// anything useful. `mediaFailureReason` reads the DOMException's name to tell
// "no microphone on this machine" from "you said no" from "the browser has not
// asked yet" — and swallowing it flattened all three into "Microphone
// unavailable", which is the least actionable of the four sentences it knows.
let lastMicError: unknown = null;

function acquireMic(): Promise<MediaStreamTrack | null> {
  const held = heldMic();
  if (held) return Promise.resolve(held);
  if (!micPending) {
    micPending = (async () => {
      try {
        // ECHO CANCELLATION IS NOT A PREFERENCE HERE. The receiver now
        // auto-listens with a hot microphone, so the burst coming out of
        // their speakers arrives back at their own open mic — and this is the
        // capture both halves of the walkie run on. Chromium turns it on for
        // `audio: true` anyway; saying it is the difference between relying on
        // a default and meaning it. The device is the one they last chose in a
        // call, so a burst and a huddle never disagree about which mic is
        // theirs.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(readJoinPrefs().micDeviceId),
        });
        const track = stream.getAudioTracks()[0] ?? null;
        if (track) {
          mic = track;
          micGranted = true;
          lastMicError = null;
        }
        return track;
      } catch (err) {
        lastMicError = err;
        return null;
      } finally {
        micPending = null;
      }
    })();
  }
  return micPending;
}

/** Whether asking for the microphone right now is certain not to prompt. */
async function micAlreadyGranted(): Promise<boolean> {
  if (micGranted) return true;
  try {
    const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return perm.state === "granted";
  } catch {
    // A browser with no Permissions API entry for the microphone cannot tell us,
    // and the whole point of a pre-warm is that it is invisible. Never guess.
    return false;
  }
}

/**
 * Open the microphone BEFORE the key goes down, so the first burst is as fast
 * as the second. Called on pointer enter of a push-to-talk surface — a gesture
 * that means "might talk", not "am talking".
 *
 * IT MUST NEVER PROMPT. A permission dialog raised by a pointer passing over a
 * button is an ambush: the person never asked for the microphone, cannot tell
 * what asked, and a denial then blocks the real press. So this proceeds only
 * where the answer is already yes, and a real press is the only thing allowed
 * to raise the question.
 */
export async function warmMic(): Promise<void> {
  if (heldMic() || micPending) {
    releaseMicLater();
    return;
  }
  if (!(await micAlreadyGranted())) return;
  await acquireMic();
  releaseMicLater();
}

// ── levels ──────────────────────────────────────────────────────────────────
//
// How loudly somebody is talking, sampled per animation frame, for a meter that
// makes the key feel alive. Its own subscription rather than a field on
// WalkieStatus: `emit` wakes every subscriber of the walkie, and a value that
// moves sixty times a second would wake all of them sixty times a second.
//
// Keyed, because both directions animate: no key is this client's own mic while
// the key is held, and a participant identity is the teammate being heard.

export type WalkieLevels = {
  /** This client's own microphone, 0 to 1. Zero when not holding the key. */
  local: number;
  /** Everyone audible in the room right now, by LiveKit participant identity. */
  remote: Record<string, number>;
};

const NO_LEVELS: WalkieLevels = { local: 0, remote: {} };
let levels: WalkieLevels = NO_LEVELS;
const levelSubscribers = new Set<() => void>();

export function subscribeWalkieLevel(cb: () => void): () => void {
  levelSubscribers.add(cb);
  return () => levelSubscribers.delete(cb);
}

export function getWalkieLevels(): WalkieLevels {
  return levels;
}

/** One number for one meter: the local mic, or one participant's voice. */
export function getWalkieLevel(participantId?: string): number {
  return participantId ? (levels.remote[participantId] ?? 0) : levels.local;
}

let meterCtx: AudioContext | null = null;
let meterAnalyser: AnalyserNode | null = null;
let meterBytes: Uint8Array<ArrayBuffer> | null = null;
let meterFrame: number | null = null;

function sameRemote(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && Math.abs(a[k] - b[k]) <= 0.02);
}

function publishLevels(local: number, remote: Record<string, number>) {
  if (Math.abs(local - levels.local) <= 0.02 && sameRemote(levels.remote, remote)) return;
  levels = { local, remote };
  for (const cb of levelSubscribers) cb();
}

// The meter is calibrated in decibels, the way meters are.
//
// `min(1, rms * 4)` was linear in amplitude, which spends nearly all of a
// meter's travel doing nothing: the dips between syllables sit at 0.005 to
// 0.0125 RMS, which that scale drew as seven to eighteen degrees of a ring. A
// quiet talker looked at a dead ring, which reads as "the microphone is not
// working" — this feature's original complaint in a different hat.
//
// -50 dBFS is the bottom and -6 the top. The floor sits just under a typical
// microphone's noise floor, so a silent room still reads zero and the ring
// never claims a voice that is not there; only a shout pegs the ceiling.
const METER_FLOOR_DB = -50;
const METER_CEIL_DB = -6;
/** Below this a measurement is a room, not a voice. The value the old linear
 *  scale gated remote speakers at (`rms * 4 > 0.02`), kept exactly. */
const METER_GATE_RMS = 0.005;

/** RMS amplitude (0..1) to meter travel (0..1). Exported for its test. */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}

function readLocalLevel(): number {
  if (!meterAnalyser || !meterBytes) return 0;
  meterAnalyser.getByteTimeDomainData(meterBytes);
  let sum = 0;
  for (let i = 0; i < meterBytes.length; i++) {
    const v = (meterBytes[i] - 128) / 128;
    sum += v * v;
  }
  return meterLevel(Math.sqrt(sum / meterBytes.length));
}

/** Everyone else's voice, straight off LiveKit's own speaker measurements —
 *  no second analyser per remote track, and no work at all when nobody is
 *  being heard. Through the SAME curve as the local meter, so the strip reads
 *  the same whether the voice on it is yours or theirs. */
function readRemoteLevels(): Record<string, number> {
  const room = getRoom();
  if (!room || !status.incoming) return {};
  const out: Record<string, number> = {};
  for (const p of room.remoteParticipants.values()) {
    // Gate on the raw measurement, before the curve lifts it into visibility.
    const raw = p.audioLevel ?? 0;
    if (raw > METER_GATE_RMS) out[p.identity] = meterLevel(raw);
  }
  return out;
}

function pumpMeter() {
  if (meterFrame !== null || typeof requestAnimationFrame !== "function") return;
  const tick = () => {
    meterFrame = null;
    const wanted = !!meterAnalyser || !!status.incoming;
    if (!wanted) {
      publishLevels(0, {});
      return;
    }
    publishLevels(meterAnalyser ? readLocalLevel() : 0, readRemoteLevels());
    meterFrame = requestAnimationFrame(tick);
  };
  meterFrame = requestAnimationFrame(tick);
}

function startLocalMeter(track: MediaStreamTrack) {
  stopLocalMeter();
  try {
    const ac = new AudioContext();
    meterCtx = ac;
    void Promise.resolve(ac.resume?.()).catch(() => {});
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    ac.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    meterAnalyser = analyser;
    meterBytes = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  } catch {
    // No meter is a flat key, not a failed burst.
    meterAnalyser = null;
  }
  pumpMeter();
}

function stopLocalMeter() {
  meterAnalyser = null;
  meterBytes = null;
  if (meterCtx) {
    void meterCtx.close().catch(() => {});
    meterCtx = null;
  }
  publishLevels(0, levels.remote);
}

// ── the burst ───────────────────────────────────────────────────────────────

type Burst = {
  channelId: string;
  roomKey: string;
  clientId: string;
  messageId: string | null;
  startedAt: number;
  /** Utterances the recognizer has closed. */
  transcript: string;
  /** The sentence still being said, revised on every delta and folded into
   *  `transcript` when it closes. Kept apart so a revision replaces it instead
   *  of stuttering the same half sentence twice into the words. */
  partial: string;
  pushed: string;
  pushedAt: number;
  mime: string;
  /** When the mic went live in the room. Null through setup. */
  openAt: number | null;
  /** When the microphone opened and the words started being kept — the first
   *  thing that happens after the press, and the honest measure of "this is
   *  recording now". */
  micAt: number | null;
  /** When the recorder actually started. Null for a browser that gave no
   *  recorder, which is what makes it the recording's own span rather than the
   *  burst's. */
  captureAt: number | null;
  /** The release beep has been played for this burst. Claimed synchronously,
   *  because "safe to call twice" has to hold for two calls in the same tick
   *  as well as two seconds apart. */
  rogered: boolean;
  /** The away tick has been played for this burst. On the BURST rather than in
   *  the watcher that decides it, because "once" here means once per hold —
   *  the roster it is decided from re-pushes for every heartbeat in the room,
   *  and a person who is not there does not become more absent each time. */
  awayToned: boolean;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  pipe: AsrPipe | null;
  pushTimer: ReturnType<typeof setInterval> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  /** The whole setup, so a release that beats the mutations still finishes. */
  ready: Promise<void>;
  done: boolean;
};

let burst: Burst | null = null;

/** Everything heard so far: the closed utterances, then the one still being
 *  said. What the bubble shows and what the server is told. */
function burstWords(b: Burst): string {
  if (!b.partial) return b.transcript;
  return b.transcript ? `${b.transcript} ${b.partial}` : b.partial;
}

function publishSending(b: Burst | null) {
  emit({
    sending: b
      ? {
          channelId: b.channelId,
          roomKey: b.roomKey,
          clientId: b.clientId,
          messageId: b.messageId,
          startedAt: b.startedAt,
          live: b.micAt !== null,
          heardLive: b.openAt !== null,
          openAt: b.openAt,
          transcript: burstWords(b),
        }
      : null,
  });
}

function recorderMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported?.(mime)) return mime;
    } catch {}
  }
  return "";
}

/** What the attachment says it is: the container, without the codec parameter
 *  a recorder reports. An <audio> element wants "audio/webm", not the full
 *  "audio/webm;codecs=opus" the browser negotiated. */
function containerMime(recorded: string): string {
  const base = (recorded || "audio/webm").split(";")[0].trim();
  return base || "audio/webm";
}

function startRecording(b: Burst, track: MediaStreamTrack) {
  try {
    const stream = new MediaStream([track]);
    const rec = b.mime ? new MediaRecorder(stream, { mimeType: b.mime }) : new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) b.chunks.push(e.data);
    };
    b.recorder = rec;
    // One timeslice, so a burst cut short by a closing tab still has bytes.
    rec.start(1_000);
    b.captureAt = Date.now();
  } catch {
    // No recorder (an old browser, a blocked codec): the burst is still live
    // audio and a live transcript, it just leaves no recording behind.
    b.recorder = null;
  }
}

function stopRecording(b: Burst): Promise<Blob | null> {
  const rec = b.recorder;
  b.recorder = null;
  const collect = () => (b.chunks.length ? new Blob(b.chunks, { type: b.mime || "audio/webm" }) : null);
  if (!rec || rec.state === "inactive") return Promise.resolve(collect());
  return new Promise((resolve) => {
    rec.onstop = () => resolve(collect());
    try {
      rec.stop();
    } catch {
      resolve(collect());
    }
  });
}

// The whole transcript so far, a few times a burst: at the end of an utterance
// when the last push has aged out, and on a timer for the utterance that never
// closes. Never per word — this patches a row every watcher of the DM is
// subscribed to.
//
// The one push that carries no news is the keepalive, and it is load-bearing:
// it is what keeps a long quiet hold from ageing into the orphan sweep.
function pushTranscript(b: Burst, onlyIfDue = false) {
  if (!convex || !b.messageId || b.done) return;
  const now = Date.now();
  if (onlyIfDue && now - b.pushedAt < TRANSCRIPT_PUSH_MS) return;
  const text = burstWords(b).trim();
  const overdue = now - b.pushedAt >= KEEPALIVE_MS;
  if (text === b.pushed && !overdue) return;
  if (!text && !overdue) return;
  b.pushed = text;
  b.pushedAt = now;
  convex.mutation(api.chat.appendVoiceTranscript, { message_id: b.messageId, content: text }).catch(() => {
    // A dropped patch is not a dropped burst: the finalize carries the whole
    // transcript anyway, so the words land either way.
  });
}

/**
 * Hold to talk. Returns when the burst is set up — the microphone open, the
 * recorder and the recognizer running on it, the server row open. A caller that
 * just wants to key the mic can ignore the promise; `endBurst` awaits it either
 * way, so a press shorter than the setup is still cancelled correctly.
 *
 * THE ROOM IS NOT IN THAT LIST. Joining it is the slowest thing a burst does
 * and the only one nothing depends on: the words are already being recorded and
 * already being recognized, so the join only decides whether a teammate hears
 * them NOW or a moment later off the message. It therefore runs behind this
 * promise, and a release that arrives before it lands still finalizes a
 * complete burst.
 */
export function startBurst(channelId: string, roomKey: string): Promise<void> {
  if (!convex) {
    refresh();
    return Promise.resolve();
  }
  if (burst) return burst.ready;
  const blocked = walkieBlockedFor(roomKey);
  if (blocked) {
    emit({ unavailable: blocked });
    return Promise.resolve();
  }

  const clientId = newChatMessageClientId();
  const b: Burst = {
    channelId,
    roomKey,
    clientId,
    messageId: null,
    startedAt: Date.now(),
    transcript: "",
    partial: "",
    pushed: "",
    // The row is as fresh as the burst is old until the first push lands.
    pushedAt: Date.now(),
    mime: recorderMime(),
    openAt: null,
    micAt: null,
    captureAt: null,
    rogered: false,
    awayToned: false,
    recorder: null,
    chunks: [],
    pipe: null,
    pushTimer: null,
    maxTimer: null,
    ready: Promise.resolve(),
    done: false,
  };
  burst = b;
  // The bubble is on screen before anything is awaited — a voice message is a
  // message, and a message never waits for a round trip to appear.
  useInboxStore.getState().beginVoiceBurstRow(channelId, clientId, roomKey);
  // THE ROOM IS CLAIMED HERE, before getUserMedia and a long way before the
  // join. Nothing between this line and the release can find the walkie in a
  // room with no owner, which is what a whole family of bugs used to be: a
  // press during somebody else's linger, the gap between a burst clearing and
  // its linger arming, the ticks an async leave spends still seated.
  enterLiveRoom(roomKey, "burst");
  emit({ error: null, unavailable: null, asr: "live" });
  publishSending(b);

  b.ready = (async () => {
    try {
      // 1. THE MICROPHONE, and nothing before it.
      //
      // Two ways to already have one, both instant next to a join: a track this
      // module warmed on hover, or the one already published into this very
      // room — hold-to-reply inside a huddle the person is sitting in. The
      // unmute comes first there, because a muted LiveKit track reads as
      // silence and the recorder would keep that silence.
      const seated = inRoom(roomKey);
      if (seated) await setMuted(false);
      if (b.done) return;
      const track = (seated ? localMicTrack() : null) ?? (await acquireMic());
      if (b.done) return;
      if (!track) {
        emit({ error: await mediaFailureReason("microphone", lastMicError) });
        await abortBurst(b);
        return;
      }
      b.micAt = Date.now();
      // The mic is open: from here every word is kept. The chirp marks that
      // instant, which is the one thing a key cannot show to somebody who is
      // looking at what they are about to talk about rather than at the key.
      soundWalkieKeyUp();

      // 2. KEEP WHAT IS BEING SAID. All local, all immediate: the recorder for
      //    the message, the recognizer for the words, the meter for the key.
      startRecording(b, track);
      startLocalMeter(track);
      b.pipe = openAsrPipe({
        convex: convex!,
        roomKey,
        track,
        clock: () => Date.now() - b.startedAt,
        events: {
          onPartial: (text) => {
            b.partial = text;
            publishSending(b);
            pushTranscript(b, true);
          },
          onUtterance: ({ text }) => {
            b.partial = "";
            b.transcript = b.transcript ? `${b.transcript} ${text}` : text;
            publishSending(b);
            pushTranscript(b, true);
          },
          // A recognizer that failed is a burst WITHOUT WORDS, not a failed
          // burst: the audio is still recorded, still lands as a message, and
          // the server transcribes it afterwards. Saying so is the whole fix —
          // these two used to be swallowed, so a refused mint and a silent room
          // were the same blank bubble.
          onFailed: () => emit({ asr: "unavailable" }),
          onDropped: () => emit({ asr: "unavailable" }),
        },
      });
      b.pushTimer = setInterval(() => pushTranscript(b), TRANSCRIPT_PUSH_MS);
      // The cap releases the key on the user's behalf: the burst lands as the
      // message it already is, and pressing again opens the next one.
      b.maxTimer = setTimeout(() => void endBurst(), MAX_BURST_MS);
      // The key is LIVE from here: meter moving, words coming, audio kept.
      publishSending(b);

      // 3. THE ROOM, behind all of it. Nothing above waits for this, and a
      //    release that beats it still lands a complete message.
      if (seated) {
        b.openAt = b.micAt;
        publishSending(b);
      } else {
        void openRoomForBurst(b, track);
      }

      const res = await convex!.mutation(api.chat.startVoiceBurst, {
        channel_id: channelId,
        client_id: clientId,
        room_key: roomKey,
      });
      b.messageId = String(res?.message_id ?? "") || null;
      publishSending(b);
      pushTranscript(b);
    } catch {
      emit({ error: "Could not start the voice message" });
      await abortBurst(b);
    }
  })();
  return b.ready;
}

/**
 * Carry the burst into the room, alongside everything else it is already doing.
 *
 * A CLONE goes to the room, never the track itself. callManager owns what it
 * publishes — it mutes it, and disconnecting stops it — and this burst is still
 * recording from the original. Cloning shares the one capture (no second
 * getUserMedia, no second permission, no second device indicator) without
 * sharing its lifetime, so a room that closes mid-word cannot truncate the
 * recording.
 *
 * Every failure here is survivable by design: a room that will not open is a
 * burst nobody hears live, which still records, still transcribes and still
 * lands as a message.
 */
async function openRoomForBurst(b: Burst, track: MediaStreamTrack): Promise<void> {
  try {
    // joinCall publishes in whatever mute state the store carries, so the
    // intent to be heard is written before the join reads it.
    useInboxStore.getState().setCallState({ muted: false });
    await joinCall(b.roomKey, { micTrack: track.clone() });
    if (b.done || !inRoom(b.roomKey)) return;
    b.openAt = Date.now();
    publishSending(b);
  } catch {}
}

/**
 * NOBODY IS LIVE TO HEAR THIS, and the sender should learn it while they are
 * still talking rather than from the silence afterwards.
 *
 * The burst is landing as a message: the person is away from their machine, or
 * their door is shut. That is the ordinary case and not a failure — the words
 * still arrive, they simply wait to be read — so it is the quiet end of the
 * set, one soft low tick, and it happens ONCE.
 *
 * The decision is not made here. Whether anybody is hearing this is a question
 * about the room's roster and the other person's door, which lives with the
 * words it also writes (hooks/useWalkie's `senderHearingFrom`); this owns only
 * the "once per hold" half, because that is a fact about the burst and the
 * watcher that calls it fires on every push of a roster.
 */
export function noteBurstUnheard(): void {
  const b = burst;
  if (!b || b.awayToned) return;
  // Not before the microphone is open: a press that has not started recording
  // yet has nothing to be unheard.
  if (b.micAt === null) return;
  b.awayToned = true;
  soundWalkieAway();
}

/** Somebody stepped into the room this burst is being spoken into, so it is a
 *  call now and the release must treat it as one: no sign-off, no mute.
 *
 *  Read off the live room rather than off the roster, because both halves of
 *  the upgrade set it — this client's Join live synchronously, the far side's
 *  when their stamp lands on the roster (hooks/useWalkieSync) — and the release
 *  must not care which of the two happened. */
function burstUpgraded(b: Burst): boolean {
  return walkieJoinedRoom(status) === b.roomKey;
}

/** Release. Lands the burst as a message, or throws it away if nothing was
 *  said. Safe to call twice — the max-length cap releases the key first, and
 *  the hand coming off it afterwards finds nothing left to do. */
export async function endBurst(): Promise<void> {
  const b = burst;
  if (!b) return;
  // THREE CONDITIONS, and each one is a sound that used to play wrongly.
  //
  // Only for a burst that got a mic: a press that never opened one has nothing
  // to sign off. Before the await, for the same reason the clock below is —
  // the sound answers the thumb, not the finalize.
  //
  // Only once, claimed synchronously through a flag of its own rather than
  // `b.done`, which is true only after an await. The max-length cap calls
  // endBurst itself, so the hand coming off the key calls it a second time in
  // the same tick and the roger beeped twice for one message.
  //
  // AND NOT INSIDE A CALL. The roger is the walkie's sign-off — message sent,
  // over — and once somebody has stepped in there is no message to sign off and
  // no turn to end. Beeping announced the end of a conversation still going on.
  if (b.micAt !== null && !b.rogered && !burstUpgraded(b)) {
    b.rogered = true;
    soundWalkieRoger();
  }
  // Stamped HERE, not inside finishBurst: that function's first act is to wait
  // for the setup this release may have beaten, and reading the clock after the
  // wait would charge the setup to the person's thumb.
  await finishBurst(b, Date.now());
}

/** Setup failed: tear down what exists and take the bubble back. Nothing was
 *  said, so nothing is announced. */
async function abortBurst(b: Burst): Promise<void> {
  teardownBurst(b);
  if (b.messageId && convex) {
    await convex.mutation(api.chat.cancelVoiceBurst, { message_id: b.messageId }).catch(() => {});
  }
  useInboxStore.getState().dropVoiceBurstRow({ clientId: b.clientId, messageId: b.messageId });
  if (burst === b) {
    burst = null;
    publishSending(null);
  }
  await setMuted(true);
  refresh();
}

/** The key is up: stop everything that was running for the hold, EXCEPT the
 *  recognizer, which still owes this burst its last sentence. */
function stopBurstWork(b: Burst) {
  b.done = true;
  if (b.pushTimer) clearInterval(b.pushTimer);
  if (b.maxTimer) clearTimeout(b.maxTimer);
  b.pushTimer = null;
  b.maxTimer = null;
  stopLocalMeter();
  releaseMicLater();
}

/** Abandon the burst outright: nothing is committed and nothing is waited for. */
function teardownBurst(b: Burst) {
  stopBurstWork(b);
  b.pipe?.close();
  b.pipe = null;
}

/**
 * How long the burst was, and whether it was anything at all.
 *
 * Two spans, because the two questions are different. The HOLD is press to
 * release, and it is the only honest test of "did somebody mean this": mic
 * acquisition, the room join and the start round trip all sit between the two,
 * and charging them to the hold made a 60ms brush measure 1.3s — so MIN_BURST_MS
 * could never fire and every brushed key posted a wordless voice note. The
 * DURATION is the recording's own span, capture to stop, which is what the
 * bubble displays and what the audio actually contains. A burst with no
 * recorder to run (an old browser, a blocked codec) has only its hold to report.
 */
export function measureBurst(input: {
  startedAt: number;
  captureAt: number | null;
  releasedAt: number;
  stoppedAt: number;
  transcript: string;
  hasAudio: boolean;
}): { durationMs: number; discard: boolean } {
  const holdMs = Math.max(0, input.releasedAt - input.startedAt);
  const durationMs = input.captureAt ? Math.max(0, input.stoppedAt - input.captureAt) : holdMs;
  // Brushed, or a burst carrying neither words nor audio: the same nothing by
  // two routes, and the caller throws both away the same way.
  const discard = holdMs < MIN_BURST_MS || (!input.transcript.trim() && !input.hasAudio);
  return { durationMs, discard };
}

async function finishBurst(b: Burst, releasedAt: number): Promise<void> {
  if (b.done) return;
  // A press shorter than its own setup: let the setup finish so there is a
  // server row to land or cancel, then land it.
  await b.ready;
  if (b.done) return;
  stopBurstWork(b);
  const blob = await stopRecording(b);
  const stoppedAt = Date.now();
  // THE LAST SENTENCE IS THE WHOLE MESSAGE, on a burst short enough to be one.
  // Closing the recognizer here — which is what release used to do — threw away
  // the utterance the server's VAD had not closed yet, so a two second burst
  // came back empty every time. `finish` commits what was said and waits,
  // bounded, for the words to come back.
  await b.pipe?.finish();
  b.pipe = null;
  // THE MICROPHONE STAYS OPEN INSIDE A CALL, and this line is where the seam
  // the founder feels used to be. Muting on release is the walkie's own
  // bargain: the mic belongs to the hold, so it closes when the hold does. It
  // is exactly wrong once somebody has stepped into the room — the burst became
  // a conversation, the person is still talking, and the key coming up cut them
  // off mid-sentence and left them to discover it. There is nothing to close
  // here, so nothing is closed.
  if (!burstUpgraded(b)) await setMuted(true);

  // Measured BEFORE the room changes hands, because the handover depends on the
  // answer: a burst that is about to be thrown away must not be handed a room
  // to hold. Both inputs are settled by here — the recording is stopped and the
  // recognizer has committed its last sentence — so this costs nothing.
  const transcript = burstWords(b).trim();
  const { durationMs, discard } = measureBurst({
    startedAt: b.startedAt,
    captureAt: b.captureAt,
    releasedAt,
    stoppedAt,
    transcript,
    hasAudio: !!blob,
  });

  if (burst === b) {
    // NOTHING HERE HAS TO BE ORDERED AGAINST ANYTHING ELSE, and that is the
    // point of the one fact. `liveRoom` was claimed at the press and no line
    // below touches it, so the room has an owner across every push in between —
    // including the audio upload and the finalize, which is where the ordinary
    // call dock used to appear by itself a beat after the person stopped
    // talking (measured at 861ms with a ten second recording, ct-46031).
    burst = null;
    publishSending(null);
    // A BRUSHED KEY GETS NO HOLD. Nothing was said, so there is no half
    // conversation to hold a room open for: a 102ms brush used to seat both
    // people in a call room for thirty seconds under a strip claiming a
    // conversation was open.
    if (discard) releaseRoom(b.roomKey);
    else lastAudioAt = Date.now();
    // Arms the seat's clock, or drops a room that never answered.
    refresh();
  }

  if (discard) {
    // Held too briefly to be speech, or carrying neither words nor audio: a key
    // somebody brushed. The row never notified and never counted, so it goes.
    //
    // The room was handed back above, before this round trip rather than after
    // it: nothing here needs the seat.
    useInboxStore.getState().dropVoiceBurstRow({ clientId: b.clientId, messageId: b.messageId });
    if (b.messageId && convex) {
      await convex.mutation(api.chat.cancelVoiceBurst, { message_id: b.messageId }).catch(() => {});
    }
    refresh();
    return;
  }

  // A recording with no recognized words is still a voice note — the server
  // accepts audio or text, and a recognizer that heard nothing is not a reason
  // to throw away what the person said.
  const mime = containerMime(b.mime);
  const storageId = blob && convex ? await uploadBlobToStorage(convex, blob, b.mime || mime) : null;
  const attachments = storageId
    ? [{ storage_id: storageId, mime, name: `voice-${b.startedAt}.${mime === "audio/mp4" ? "m4a" : "webm"}` }]
    : [];

  if (!b.messageId) {
    // The row never opened (the start mutation failed), so there is nothing to
    // land and nothing anyone else ever saw. Say so rather than leaving a
    // bubble that looks sent.
    emit({ error: "Could not send the voice message" });
    useInboxStore.getState().dropVoiceBurstRow({ clientId: b.clientId, messageId: null });
    refresh();
    return;
  }
  const outcome = convex
    ? await landBurst(convex, {
        messageId: b.messageId,
        content: transcript,
        durationMs,
        attachments,
      })
    : "unresolved";
  if (outcome === "landed") {
    useInboxStore.getState().updateVoiceBurstRow(
      { clientId: b.clientId, messageId: b.messageId },
      {
        content: transcript,
        status: "done",
        durationMs,
        attachments: attachments.length ? attachments : undefined,
      },
    );
  } else if (outcome === "cancelled") {
    // The server confirmed it threw the burst away, so the row may go. This is
    // the ONLY outcome that earns that: erasing a row the server might still
    // hold would be gone from the sender's screen, present on everyone else's.
    emit({ error: "Could not send the voice message" });
    useInboxStore.getState().dropVoiceBurstRow({ clientId: b.clientId, messageId: b.messageId });
  } else {
    // Unresolved: the network answered nothing, so the row is still LIVE over
    // there and the orphan sweep will land it — words and all — the next time
    // anybody talks in that room. Only the recording is lost, because the
    // upload had nowhere to go.
    //
    // Leaving the row alone kept it pulsing "talking…" on the sender's own
    // screen with their hand off the key, beside a toast saying the message had
    // failed. Two contradictory claims, both wrong. So it paints the outcome
    // the row most likely already has — a finished voice message carrying the
    // transcript and no recording, which the bubble renders honestly — and lets
    // the channel's own sync reconcile if the sweep discards it instead.
    emit({ error: "The recording did not send — the words are on their way" });
    useInboxStore.getState().updateVoiceBurstRow(
      { clientId: b.clientId, messageId: b.messageId },
      { content: transcript, status: "done", durationMs },
    );
  }
  // No hold armed here: the clock started when the mic closed, above.
  refresh();
}

/**
 * The last round trip of a burst, and the one place that decides what a failed
 * one means. A burst that cannot be finalized is not a message — the audio is
 * over and cannot be replayed later — so the fallback is to cancel it, exactly
 * as a burst too short to mean anything is cancelled.
 *
 * Three honest answers, because the sender's own bubble depends on which:
 *   landed     — it is a message; paint it done.
 *   cancelled  — the server took it back; nothing exists anywhere.
 *   unresolved — nobody answered; the row's fate is the server's to settle.
 */
export async function landBurst(
  convex: ConvexHandle,
  opts: {
    messageId: string;
    content: string;
    durationMs: number;
    attachments: Array<{ storage_id: string; mime: string; name: string }>;
  },
): Promise<"landed" | "cancelled" | "unresolved"> {
  try {
    await convex.mutation(api.chat.finalizeVoiceBurst, {
      message_id: opts.messageId,
      content: opts.content,
      duration_ms: opts.durationMs,
      attachments: opts.attachments.length ? opts.attachments : undefined,
    });
    return "landed";
  } catch {
    try {
      await convex.mutation(api.chat.cancelVoiceBurst, { message_id: opts.messageId });
      return "cancelled";
    } catch {
      return "unresolved";
    }
  }
}

// ── handing the seat back ───────────────────────────────────────────────────

/**
 * Whether a seat is still worth holding, or may go back.
 *
 * Engaged means the room is a conversation: still talking, still being talked
 * to, or somebody stepped in on purpose.
 *
 * THE MUTE USED TO BE THAT LAST TEST, and it cannot be any more. An open
 * microphone meant a person had joined, back when a listener's mic was closed;
 * with hot auto-listen every listener's mic is open, so reading it that way
 * would seat the whole team in a room forever off one sentence. The mode
 * carries the intent instead, which is the only thing that ever really meant
 * "this became a call" — and it covers a room the person was already in, so a
 * huddle somebody joined by hand is never handed back by a timer.
 *
 * So the open mic has a bounded life: the burst, plus the half minute an answer
 * might arrive in, and then it closes on its own unless somebody joined. That
 * bound is the safety of the whole hot-mic decision.
 */
export function shouldReleaseRoom(input: {
  mode: WalkieRoomMode;
  bursting: boolean;
  incoming: boolean;
}): boolean {
  if (input.mode === "call") return false;
  return !input.bursting && !input.incoming;
}

/**
 * Hand a room back, if it is ours to hand back and nothing is happening in it.
 *
 * THE LIVE ROOM IS DROPPED AFTER THE LEAVE, not before, and that is the whole
 * of what a `releasing` marker used to be. Leaving is async — `leaveCall`
 * awaits the scribe before `call.phase` moves — so between the decision and the
 * seat actually going there are ticks in which this client is still seated and
 * connected. Saying nothing owns the room across them is what let the ordinary
 * call dock flash over a room in the middle of disappearing (ct-46031).
 */
function releaseRoom(roomKey: string) {
  const live = status.liveRoom;
  if (!live || live.key !== roomKey) return;
  if (!shouldReleaseRoom({ mode: live.mode, bursting: !!burst, incoming: !!status.incoming })) return;
  // Nothing seated: there is no seat to hand back, only a claim to drop.
  if (!inRoom(roomKey)) {
    leaveLiveRoom();
    return;
  }
  void leaveCall().finally(() => {
    if (status.liveRoom?.key === roomKey) leaveLiveRoom();
  });
}

// ── the upgrade ─────────────────────────────────────────────────────────────
//
// A burst and a call are the same room. What separates them is whether a
// person decided to be in it, so the upgrade is a decision being recorded
// rather than any machinery being started: nothing connects, nothing joins,
// no track is republished. The strip becomes the dock and the seat stops
// being on loan.

/**
 * Somebody stepped into this room on purpose — me, or the person I am talking
 * to. Idempotent, and deliberately not scoped to the burst: the call outlives
 * it, and so does this.
 */
export function markWalkieUpgraded(roomKey: string): void {
  if (walkieJoinedRoom(status) === roomKey) return;
  enterLiveRoom(roomKey, "call");
  refresh();
}

/**
 * JOIN LIVE. The one gesture the whole upgrade exists for, and it is one
 * click: the person is already seated and already audible, so nothing here
 * touches the media plane except to put the camera back the way they left it.
 *
 * The stamp goes to the server through the ordinary join path, which knows to
 * treat a room it is already in as an intent rather than a no-op
 * (callManager's `applyDeliberateJoin`). That is what tells the OTHER side,
 * whose surface upgrades off the same roster row.
 *
 * The seat's clock stops with it: a room somebody stepped into is theirs until
 * they leave it, and no timer of ours may take it.
 */
export async function joinWalkieLive(
  roomKey: string,
  /** Who is on the other end, when the surface that offered the button knows.
   *  Only the sentence uses it — "You joined Jordan" rather than "You joined
   *  the call" — so a caller that cannot name them still joins the same way. */
  opts: { name?: string | null } = {},
): Promise<void> {
  markWalkieUpgraded(roomKey);
  // SAID BEFORE THE JOIN, not after it. The person pressed a button and the
  // answer to a press has to be immediate; the stamp is a round trip away, and
  // this side already knows what it did. The far side hears its own version of
  // this sentence off the roster (hooks/useWalkieSync).
  announceJoin(roomKey, youJoinedText(opts.name));
  // THE SAME CUE ON BOTH SIDES. The far side hears this off the roster stamp
  // (hooks/useWalkieSync); nothing was playing it for the person who actually
  // pressed the button, so the one gesture that turns a burst into a call was
  // the only one in the set that made no sound.
  soundWalkieJoined();
  await joinCall(roomKey, { intent: "deliberate", walkieJoin: true });
}

/**
 * SNOOZE. Shut the door now, not at the next push.
 *
 * The pref and the snooze are both read by the watcher, so the door would
 * close on its own within a push either way — but this is pressed to stop a
 * voice that is playing at this second, and "within a push" is not what the
 * button promises. So the burst is dropped and the seat handed straight back,
 * which closes the hot microphone with it.
 *
 * The message is untouched. It lands in the DM with its unread and its push,
 * exactly as it does behind a closed door: snoozing mutes a speaker, it never
 * silences one.
 */
export function shutWalkieDoor(): void {
  const was = status.incoming;
  // The upgrade is deliberately NOT cleared. Snooze shuts a door; it does not
  // hang up a call somebody chose to be in. If both were somehow true, clearing
  // it here would let the handback below leave a live conversation — a
  // "not now" button ending a call is the wrong reading of the word.
  if (was) emit({ incoming: null });
  const held = status.liveRoom;
  if (held) releaseRoom(held.key);
  refresh();
}

// ── the receiving half ──────────────────────────────────────────────────────

export type LiveBurstRow = {
  messageId: string;
  channelId: string;
  roomKey?: string;
  fromUserId: string;
  fromName: string;
  createdAt: number;
};

/**
 * Which burst, if any, this client should be hearing. The newest one wins — a
 * second teammate keying up while the first talks is the more recent thing said
 * to you, and one pair of ears cannot follow two rooms.
 *
 * A row without a room key is a burst nobody can join (an older client, or a
 * sender who never reached the media plane), and a row past the server's live
 * window belongs to a tab that died mid-word — the sweep will land or discard
 * it the next time anyone talks in that room. Neither is something to join.
 */
export function pickLiveBurst(bursts: LiveBurstRow[], now: number): LiveBurstRow | null {
  let best: LiveBurstRow | null = null;
  for (const b of bursts) {
    if (!b.roomKey) continue;
    if (now - b.createdAt >= BURST_STALE_MS) continue;
    if (!best || b.createdAt > best.createdAt) best = b;
  }
  return best;
}

/**
 * The watcher's report, called on every push of the live-burst subscription
 * (hooks/useWalkieSync). `doorOpen` is the recipient's whole policy — the
 * walkie pref, their status, and whether they are actually at the machine —
 * decided there and applied here.
 *
 * Door open and someone is talking: join their room muted, so their voice comes
 * out of the existing audio host. Door closed: nothing happens at all, and the
 * burst lands as an ordinary chat message with its unread and its push.
 */
export function observeWalkie(input: { bursts: LiveBurstRow[]; doorOpen: boolean }): void {
  lastReport = input;
  applyReport();
}

/** Re-decide with the same report and a fresh view of the call plane — the
 *  user joined a huddle, or left one, which is the other half of the answer. */
export function refreshWalkie(): void {
  applyReport();
}

let lastReport: { bursts: LiveBurstRow[]; doorOpen: boolean } = { bursts: [], doorOpen: false };
/** When this client started hearing the burst it is hearing now. The listening
 *  side's only measure of whether anything was actually said. */
let incomingSince = 0;

function applyReport(): void {
  const { bursts: rows, doorOpen } = lastReport;
  const current = pickLiveBurst(rows, Date.now());

  // Our own key is down: we are already in a room and hearing whoever is in it.
  if (burst) {
    refresh();
    return;
  }

  if (current && doorOpen && !busyElsewhere(current.roomKey)) {
    if (status.incoming?.messageId !== current.messageId) {
      const incoming: WalkieIncoming = {
        channelId: current.channelId,
        messageId: current.messageId,
        roomKey: current.roomKey!,
        fromUserId: current.fromUserId,
        fromName: current.fromName,
        createdAt: current.createdAt,
      };
      incomingSince = Date.now();
      // The room is claimed in the same push that publishes the burst — and
      // claiming it is all a teammate's burst arriving during our own hold-open
      // has to do, because one room key replaces another with nothing in
      // between.
      enterLiveRoom(incoming.roomKey, "listen");
      emit({ incoming });
      // Their voice gets a meter too, so a surface can animate the burst it is
      // hearing the same way it animates the one being spoken.
      pumpMeter();
      soundWalkieOpen();
      if (!inRoom(incoming.roomKey)) {
        // HOT. Hearing someone means they can hear you — a walkie is not a
        // speaker, and half a channel is not a channel. This is the founder's
        // decision and it overrides the muted auto-join this line used to be:
        // "make sure your mics are not muted by default ever".
        //
        // The DOOR is what makes that safe rather than reckless. Nothing
        // reaches here unless the pref is open, the person is not busy, not
        // snoozed, at this machine with the tab in front of them, and not in
        // some other call — and the strip says the mic is open in words, with
        // Mute one click away, the moment it happens.
        //
        // The camera stays off, always. Being heard is the bargain; being seen
        // is never something that happens to somebody.
        //
        // Only when the walkie is the one TAKING the seat. Somebody already
        // sitting in this room has their own mute state, and it is a choice
        // they made; opening a microphone a person deliberately closed is the
        // one thing the door cannot consent to on their behalf.
        useInboxStore.getState().setCallState({ muted: false });
        void joinCall(incoming.roomKey);
      }
    }
  } else if (status.incoming) {
    // Their key came up (the row is no longer live) or the door closed while
    // they were talking. Hold the room briefly either way — an answer is the
    // most likely next thing to happen.
    //
    // Unless there was nothing to answer. A burst the sender threw away leaves
    // exactly the same trace here as one that landed: the live row simply
    // stops being live, and this side cannot read the outcome (the message
    // itself only syncs for a channel somebody has open, and a burst arrives
    // wherever you happen to be). What this side CAN measure is how long it
    // heard, and that is the same question MIN_BURST_MS already asks of the
    // hand on the key: under it, nobody said anything. Without this a brushed
    // key seated the LISTENER in a call room for half a minute too, under a
    // strip claiming a conversation was still open.
    const was = status.incoming;
    const heardMs = Date.now() - incomingSince;
    // NOBODY ENDED THIS ONE. A burst still marked live long after the sender's
    // own cap could have stopped it is a tab that died mid-word, not a hold
    // that finished — this is the ceiling above arriving, or a push that
    // happened to re-ask the question. Either way there is no half
    // conversation to hold a room open for and nobody left to answer, so the
    // seat goes back now rather than after another half minute of open
    // microphone. Same judgement the engine already makes about a brushed key,
    // for the same reason.
    const stale = Date.now() - was.createdAt >= BURST_STALE_MS;
    emit({ incoming: null });
    if (heardMs < MIN_BURST_MS || stale) releaseRoom(was.roomKey);
    else {
      // The tail closes what soundWalkieOpen opened. Under the same threshold
      // as the hold-open, so a key somebody brushed makes no sound at either
      // end.
      soundWalkieSquelch();
      // Audio was last in this room just now, so the half minute an answer
      // might arrive in counts from here.
      lastAudioAt = Date.now();
    }
  }
  refresh();
}

// The window dying with the key still down.
//
// callManager already stops the audio when the tab goes. The MESSAGE did not:
// its row stayed `live`, so until the orphan sweep caught it every receiver's
// strip said "Riley is talking" over a dead level and no voice — the one
// reading a working walkie must never produce.
//
// The recording cannot be saved (an upload cannot finish in an unload handler),
// but the transcript is already on the row, so this lands what the sweep would
// have landed anyway, immediately. Over HTTP rather than through the client: a
// mutation written to the WebSocket at unload does not reliably leave before
// the socket is torn down (lib/keepaliveMutation carries the measurement).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    const b = burst;
    if (!b || b.done || !b.messageId) return;
    // Claim it here so a release racing the unload cannot finalize it twice.
    b.done = true;
    const words = burstWords(b).trim();
    if (words) {
      mutateOnUnload(api.chat.finalizeVoiceBurst, {
        message_id: b.messageId,
        content: words,
        duration_ms: Date.now() - b.startedAt,
      });
    } else {
      // Nothing was said yet, and the recording cannot be uploaded from a
      // dying page — so there is no message here, only a live row. The server
      // says the same thing if you ask it to finalize one ("a voice message
      // needs audio or a transcript"), which is the same judgment landBurst
      // makes when a finalize is refused.
      mutateOnUnload(api.chat.cancelVoiceBurst, { message_id: b.messageId });
    }
  });
}

// SURVIVING A HOT MODULE REPLACEMENT, in dev and nowhere else.
//
// A replaced walkie.ts comes up with no Convex client and nothing re-binds it:
// the effect that calls `bindWalkie` runs when the app mounts, and a module
// swap is not a mount. So every gesture no-ops and push-to-talk is dead until
// somebody reloads the page, which is a slow way to learn you edited this file.
//
// Vite hands the outgoing module's `hot.data` to the incoming one, so the
// client rides across the swap and the engine binds itself back. Last in the
// file, because binding refreshes and a refresh reads state declared above.
if (import.meta.hot) {
  const carried = import.meta.hot.data.walkieConvex as ConvexHandle | undefined;
  if (carried) bindWalkie(carried);
}

// Dev console / e2e access to the real module instance, exactly as callManager
// and the scribe expose theirs (a dynamic import() of this file would be a
// second instance with its own empty state).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__walkie = {
    status: getWalkieStatus,
    startBurst,
    endBurst,
    warmMic,
    levels: getWalkieLevels,
    observe: observeWalkie,
    blockedFor: walkieBlockedFor,
    bound: () => !!convex,
    // The upgrade, for a headless rig: it is otherwise reachable only through
    // a button on a floating surface, and the release path it changes (no
    // mute, no roger) is the one thing about this feature a screenshot cannot
    // show.
    markUpgraded: markWalkieUpgraded,
    joinLive: joinWalkieLive,
  };
}
