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
// bubble through chatSlice actions. Three siblings carry the rest — the device
// (./walkieMic), the meters (./walkieMeter) and the message a burst becomes
// (./walkieMessage) — so this file is the state machine and nothing else.
//
// WHO OWNS THE ROOM. callManager does, always. The walkie asks it to join, to
// mute and to leave; it never touches the Room itself. That is also why walkie
// is UNAVAILABLE while the user is in another huddle: hijacking a live call to
// shout into a DM would be a media-plane fight nobody asked for, so the status
// says so instead and the UI disables push-to-talk.
//
// THE ORDER A BURST DOES THINGS IN. The microphone first (./walkieMic), the
// recorder and the recognizer on that track, and the room LAST, carrying a
// clone — so nothing a person says waits on a join. `sending.live` says the
// words are being kept; `sending.heardLive` says somebody is hearing them now.
//
// WHICH SURFACE IS ON SCREEN, in two sentences. The walkie holds ONE room at a
// time and knows only what that room is — a burst going out, a burst coming in,
// or a call somebody stepped into on purpose — so `liveRoom` is the single
// fact, and `walkieHoldsRoom` is the whole question a surface asks. A burst or
// a listen draws the strip; a call draws the ordinary dock, and the stage when
// the person expanded it.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { CHAT_CHANNEL_STUB_PREFIX, newChatMessageClientId, resolveChannelStubId } from "../../store/chatSlice";
import { joinCall, leaveCall, mediaFailureReason, setCamera, setMuted } from "./callManager";
import { openAsrPipe, type AsrPipe } from "./asrPipe";
import {
  acquireMic,
  bindMicInUse,
  localMicTrack,
  micFailureReason,
  releaseMicLater,
  warmMic,
} from "./walkieMic";
import {
  bindWalkieHearing,
  getWalkieLevels,
  pumpWalkieMeter,
  startLocalMeter,
  stopLocalMeter,
} from "./walkieMeter";
import { MIN_BURST_MS, containerMime, landBurst, measureBurst, recorderMime } from "./walkieMessage";
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
import { announceJoin, clearJoinAnnouncement, youJoinedText } from "./joinAnnounce";

const api = _api as any;

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

// A hard stop on one hold: nobody walkie-talks for two minutes, and a key
// wedged down by a stuck event must not record forever. The cap lands the burst
// as an ordinary message. It is NOT a race against the orphan sweep — the
// transcript pushes below rewrite the row every couple of seconds, so a burst
// still being spoken into keeps itself alive.
// A talk is a TOGGLE now — click to start, click to stop — so the cap is the
// backstop for a person who walked away mid-talk, not the length of a sentence.
const MAX_BURST_MS = 5 * 60_000;
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
   *  word from here on is being KEPT, whatever the room is doing. What a
   *  push-to-talk key should light on — true within a tenth of a second of the
   *  press, because nothing but getUserMedia precedes it. */
  live: boolean;
  /** The track reached the room, so a teammate at their desk hears this as it
   *  is spoken. Later than `live` by 1.0s warm and 12.7s cold — a gap that
   *  costs immediacy and never words, because everything said in it is still
   *  recorded, transcribed, and landed in the message. */
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
   *  it is the only thing that can bound a hot listen: the row stops changing
   *  the moment it starts, so age is the one fact that keeps moving. */
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
  /** When this client's involvement with this room began, steady across a
   *  change of mode. It is what tells a fresh join stamp from one a browser
   *  that died left behind. */
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
   * answers, let alone the room — until the seat is genuinely handed back, so a
   * tick in which this client is seated and nothing owns the room is now
   * unrepresentable rather than defended (ct-46031).
   */
  liveRoom: WalkieLiveRoom | null;
  /** Why push-to-talk cannot be used; null when it can. */
  unavailable: null | "another-call" | "not-ready";
  /** True when holding the key would answer someone — the reply affordance. */
  canReply: boolean;
  /**
   * Whether live words are coming back from the recognizer, for the most recent
   * burst. A DOWN RECOGNIZER IS NOT A FAILED BURST: the audio still records,
   * the message still lands, and the server transcribes it afterwards — so a
   * surface can say "recording, no live words" instead of showing an empty
   * transcript that reads as silence. It describes the last burst rather than
   * the moment, and the next press resets it.
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

// The meter samples remote voices only while a teammate's burst is playing, and
// that is the whole of what it needs to know about the state machine.
bindWalkieHearing(() => !!status.incoming);
// And the microphone's: a key still down holds the device, however long.
bindMicInUse(() => !!burst);

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

// The siblings, re-exported: which of the four files a level, a duration or the
// microphone lives in is not a caller's business — a surface asks the walkie.
export { MIN_BURST_MS, landBurst, measureBurst } from "./walkieMessage";
export { warmMic } from "./walkieMic";
export {
  getWalkieLevel,
  getWalkieLevels,
  meterLevel,
  subscribeWalkieLevel,
  type WalkieLevels,
} from "./walkieMeter";

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
 * from the only three ways in: a press, a teammate's burst starting to play,
 * and somebody stepping in on purpose. A room that is already a `call` stays
 * one, so a second burst spoken inside a call cannot turn it back into a burst.
 */
function enterLiveRoom(key: string, mode: WalkieRoomMode): void {
  const held = status.liveRoom?.key === key ? status.liveRoom : null;
  const next = nextRoomMode(held?.mode ?? null, mode, { seated: inRoom(key) });
  if (held?.mode === next) return;
  emit({ liveRoom: { key, mode: next, since: held?.since ?? Date.now() } });
}

/**
 * WHAT THE ROOM BECOMES when a gesture arrives in a room already held. Three
 * lines, exported because it IS the state machine's transition and a rule that
 * lives inside a setter is a rule nobody can check.
 *
 * A CALL STAYS A CALL. Somebody decided to be in this room; nothing a burst
 * does takes that back.
 *
 * A ROOM ALREADY SAT IN IS A CALL. Hold-to-reply inside a huddle is a guest
 * speaking in somebody else's room: the huddle keeps its own dock and its
 * hang-up, and no timer of ours may take its seat. Asked at the instant of the
 * gesture, about the pre-burst world, which is what a separate `guest` flag
 * used to record.
 *
 * AND A ROOM MY OWN KEY IS DOWN IN STAYS MINE. Two people pressing at once is
 * one room with voices going both ways, not a room that changes hands
 * mid-sentence: their burst arriving while I am talking is a reply into what I
 * opened. The mode says what THIS client is doing here; that both directions
 * are live is `sending` and `incoming`, which is where a surface reads it.
 */
export function nextRoomMode(
  held: WalkieRoomMode | null,
  gesture: WalkieRoomMode,
  ctx: { seated: boolean },
): WalkieRoomMode {
  if (held === "call") return "call";
  if (!held) return ctx.seated ? "call" : gesture;
  if (held === "burst" && gesture === "listen") return "burst";
  return gesture;
}

function leaveLiveRoom(): void {
  if (!status.liveRoom) return;
  // THE TITLE DIES WITH THE ROOM. "Jordan joined — it's a call now" is news
  // about a room, and the room ending is the moment it stops being news: a
  // hang-up inside the four seconds used to leave the sentence sitting on the
  // next thing that opened, announcing a join into a room nobody was in.
  clearJoinAnnouncement();
  mutedByRelease = null;
  emit({ liveRoom: null });
}

/**
 * THE QUESTION EVERY SURFACE ASKS: is the walkie holding this room, as a burst
 * rather than as a call?
 *
 * Yes means the strip, and the ordinary call dock stands down — a burst joins a
 * room exactly the way a huddle does, so without this the floating call window
 * would open for every sentence anybody says. No means the room is a
 * conversation and the dock's, however it became one. `roomKey` null asks about
 * the walkie alone, which is the honest question when a burst outlives the room
 * it was spoken into: the recorder is still running and the message still lands.
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
 * ONE RULE FOR THREE THINGS that used to have one each: a hold-open whose room
 * the person walked out of, a join stamp outliving the call it named, and a
 * burst whose room fell over. All three are the same sentence — the walkie is
 * not in that room any more — and this runs on every move of the call plane
 * (useWalkieSync refreshes on roomKey:phase), so none can outlive it.
 *
 * A burst or a listen in flight is exempt: it owns a room the join has not
 * landed in yet, so nothing is seated and there is nothing to be wrong about.
 */
function reconcileLiveRoom(): void {
  const live = status.liveRoom;
  if (!live) return;
  if (burst || status.incoming) return;
  if (!inRoom(live.key)) leaveLiveRoom();
}

// ── the seat's own clock ────────────────────────────────────────────────────
//
// A SEAT NEEDS A CLOCK, because auto-listen is hot — a burst holds the
// receiver's microphone open — and nothing else in this path counts.
//
// One timer, one deadline, derived from the state rather than armed by events.
// That is the difference from what it replaces: a linger timer, a separate
// hot-listen ceiling, a `lingerRoomKey`, a `ceilingFor` and three cleanup
// paths, each existing partly to stop one of the others going wrong.
//
// A LISTEN gets the burst's own outer bound, because the server's "this burst
// is over" push never comes if the sender's tab dies mid-word: the row stays
// live forever, the sweep runs only as a side effect of the next burst in that
// channel, and `chat.listLiveVoiceBursts` returns a byte-identical result that
// wakes nobody. A HELD ROOM gets half a minute from the last audio in it, so an
// answer does not arrive at an empty room. A key in hand and a call somebody
// stepped into get no clock at all.
//
// A listen's ceiling runs INSIDE a call too: the dead row still has to be
// cleared there. Handing the seat back is `shouldReleaseRoom`'s decision and it
// refuses for a call, which is what keeps a timer from ever hanging one up.

// Room for a full-length burst to finish and report itself: MAX_BURST_MS is the
// same 120s as the staleness window, so a legitimate monologue reaches the line
// at the moment it stops and its upload has to land after that.
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
  // The deadline is NOT cleared with the timer. A release can be refused (a
  // room somebody stepped into) or take a moment to land, and a reconcile that
  // then computed the same past deadline would arm it again — a one second poll
  // calling `leaveCall` over and over. Keeping it means the reconcile below
  // sees no change and does nothing; every state that could change the answer
  // refreshes on its own.
  idleTimer = null;
  const live = status.liveRoom;
  if (!live) return;
  // A burst still marked live at this point belongs to a tab that died: no
  // push is coming to end it and nobody is left to answer. Dropping it is what
  // lets the seat go back — and it is right inside a call too, where the
  // release refuses and only the dead row is cleared.
  if (status.incoming) emit({ incoming: null });
  releaseRoom(live.key);
  refresh();
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
   *  the watcher, because "once" means once per hold: the roster it is decided
   *  from re-pushes on every heartbeat, and a person who is not there does not
   *  become more absent each time. */
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
// subscribed to. The keepalive push carries no news and is load-bearing: it
// keeps a long quiet hold from ageing into the orphan sweep.
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

/** How long a burst will wait for its channel to become real before giving up.
 *  Only a press into a DM that does not exist yet (or has not synced yet) pays
 *  it, the recording runs throughout, and a channel create is one mutation —
 *  seconds, not the two minutes a burst itself may run. */
const CHANNEL_RESOLVE_MS = 8_000;

/** The server id behind a channel the surface knows only optimistically,
 *  read from the live store (the pure matching lives in chatSlice). */
function serverChannelIdFor(stubId: string): string | null {
  return resolveChannelStubId(useInboxStore.getState().chatChannels as Record<string, any>, stubId);
}

/** A channel id the server will accept, or null once waiting stops making
 *  sense. Real ids pass straight through; a stub waits — bounded, and never
 *  past the burst's own end — for the row that makes it real. */
async function resolveServerChannelId(b: Burst, channelId: string): Promise<string | null> {
  if (!channelId.startsWith(CHAT_CHANNEL_STUB_PREFIX)) return channelId;
  const now = serverChannelIdFor(channelId);
  if (now) return now;
  const deadline = Date.now() + CHANNEL_RESOLVE_MS;
  return await new Promise((resolve) => {
    const tick = () => {
      const found = serverChannelIdFor(channelId);
      if (found || b.done || Date.now() > deadline) {
        resolve(found);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
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
  // A new hold supersedes whatever the last release decided about the mic.
  mutedByRelease = null;
  // The bubble is on screen before anything is awaited — a voice message is a
  // message, and a message never waits for a round trip to appear.
  useInboxStore.getState().beginVoiceBurstRow(channelId, clientId, roomKey);
  // THE ROOM IS CLAIMED HERE, before getUserMedia and long before the join, so
  // nothing between this line and the release can find the walkie in a room
  // with no owner. That was a whole family of bugs: a press during a room still
  // held open, the gap between a burst clearing and its hold arming, the ticks
  // an async leave spends still seated.
  enterLiveRoom(roomKey, "burst");
  emit({ error: null, unavailable: null, asr: "live" });
  publishSending(b);

  b.ready = (async () => {
    try {
      // 1. THE MICROPHONE, and nothing before it. Two ways to already have
      // one: a track this module warmed on hover, or the one already published
      // into this very room (hold-to-reply inside a huddle). The unmute comes
      // first there, because a muted LiveKit track reads as silence and the
      // recorder would keep that silence.
      if (inRoom(roomKey)) await setMuted(false);
      if (b.done) return;
      // THE TEST IS A PUBLICATION, NOT A SEAT. `inRoom` counts a room still
      // CONNECTING, which is the ordinary shape of an answer into a burst this
      // client only just started listening to: the seat exists, the microphone
      // is not in the room yet. Reading that as "my mic is already here" made
      // the burst skip the join it needed and then claim it was being heard.
      const published = localMicTrack();
      const track = published ?? (await acquireMic());
      if (b.done) return;
      if (!track) {
        emit({ error: await micFailureReason() });
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
          // burst. Saying so is the whole fix: these two used to be swallowed,
          // so a refused mint and a silent room were the same blank bubble.
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
      //    release that beats it still lands a complete message. A track that
      //    was ALREADY publishing is already being heard; anything else has to
      //    be carried in.
      if (published) {
        b.openAt = b.micAt;
        publishSending(b);
      } else {
        void openRoomForBurst(b, track);
      }

      // The surface may have handed us an optimistic stub — a face pressed
      // before its DM existed, or before the channel sync loaded. The server
      // validates channel_id as a real document id, so a stub sent as-is is a
      // burst aborted every time. The words are already being recorded either
      // way, so waiting here costs nothing audible.
      const serverChannelId = await resolveServerChannelId(b, channelId);
      if (b.done) return;
      if (!serverChannelId) {
        emit({ error: "Could not start the voice message" });
        await abortBurst(b);
        return;
      }
      const res = await convex!.mutation(api.chat.startVoiceBurst, {
        channel_id: serverChannelId,
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
    // YOUR OWN FACE, while you hold the key. A walkie is a person talking, and
    // hearing a voice out of a dark circle is less of a conversation than
    // seeing who is speaking.
    //
    // Only when the camera is off: one already on belongs to the person (or to
    // the huddle this hold is happening inside), and the release must not
    // close it. Only after the room exists, since a camera with nowhere to
    // publish is a device light for no reason. Failure is survivable — the
    // burst is audio, and a refused camera must never cost the message.
    if (!useInboxStore.getState().call.camera) {
      cameraByBurst = true;
      await setCamera(true, { remember: false }).catch(() => {});
      // The key can come up while the device is still opening: the release
      // then ran its close against a camera that was not on yet, and the
      // open landing afterwards would leave the light on. Close it again.
      if (b.done && !burstUpgraded(b)) {
        cameraByBurst = true;
        await closeBurstCamera();
      }
    }
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

/**
 * THE ROOM WHOSE MICROPHONE THIS CLIENT'S OWN RELEASE CLOSED, and the only
 * microphone the walkie may open again without being asked.
 *
 * A join stamp is a round trip behind the gesture that made it, so the far
 * side pressing Join live a moment before the key comes up lands a moment
 * after: the release still reads the room as a burst, mutes, and the person is
 * left in a call that says "it's a call now" over a closed mic. Reopening it
 * needs to know that the mic was closed BY THE RELEASE rather than by the
 * person — otherwise the same rule would open the microphone of a muted
 * lurker in a huddle the moment anybody stepped into a burst there.
 */
let mutedByRelease: string | null = null;

/**
 * THE CAMERA THE HOLD OPENED, and the only camera the release may close.
 *
 * Holding the key shows your own face while you talk — the founder's ask, and
 * the reason it is safe here and nowhere else in the walkie: YOU pressed
 * something. A camera opened by somebody else's burst arriving would be a
 * machine deciding to film you, which is why the auto-answer seat stays dark.
 *
 * Remembered as a flag rather than assumed on release, because the person may
 * have had their camera on already (holding the key inside a huddle): closing
 * it then would turn off a camera the release never turned on.
 */
let cameraByBurst = false;

/** Put the camera back the way the hold found it. Idempotent, and safe on
 *  every exit path — a burst that never opened one has nothing to close. */
async function closeBurstCamera(): Promise<void> {
  if (!cameraByBurst) return;
  cameraByBurst = false;
  // `remember: false`: a hold is not a decision about how the next huddle
  // starts, so this must not rewrite the person's camera preference.
  await setCamera(false, { remember: false }).catch(() => {});
}

/** Somebody stepped into the room this burst is being spoken into, so it is a
 *  call now and the release must treat it as one: no sign-off, no mute. Read
 *  off the live room rather than the roster, because both halves of the upgrade
 *  set it and the release must not care which happened. */
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
  // The camera the hold opened goes with the hold, on every path that ends
  // one — the release, the length cap, and a setup that failed. UNLESS
  // somebody stepped in: the burst is a call now, the face belongs to the
  // conversation, and closing it would blank the person mid-sentence.
  if (!burstUpgraded(b)) void closeBurstCamera();
  else cameraByBurst = false;
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
  // the founder feels used to be. The mic belongs to the hold, so it closes
  // when the hold does — exactly wrong once somebody has stepped in: the person
  // is still talking, and the key coming up cut them off mid-sentence and left
  // them to discover it.
  if (!burstUpgraded(b)) {
    await setMuted(true);
    // Remembered, because a stamp already in flight may be about to make this
    // the wrong answer — see `mutedByRelease`.
    mutedByRelease = b.roomKey;
  }

  // Measured BEFORE the room changes hands, because the handover depends on
  // the answer: a burst about to be thrown away must not be handed a room to
  // hold. Both inputs are settled by here, so it costs nothing.
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
    // NOTHING HERE HAS TO BE ORDERED AGAINST ANYTHING ELSE, which is the point
    // of the one fact: `liveRoom` was claimed at the press and no line below
    // touches it. The room has an owner across the audio upload and the
    // finalize, which is where the call dock used to appear by itself a beat
    // after the person stopped talking (861ms with a ten second recording).
    burst = null;
    publishSending(null);
    // A BRUSHED KEY GETS NO HOLD: nothing was said, so there is no half
    // conversation to hold a room open for. A 102ms brush used to seat both
    // people for thirty seconds under a strip claiming a conversation was open.
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

// ── handing the seat back ───────────────────────────────────────────────────

/**
 * Whether a seat is still worth holding, or may go back. It stays while the
 * room is a conversation: still talking, still being talked to, or somebody
 * stepped in on purpose.
 *
 * THE MUTE USED TO BE THAT LAST TEST and cannot be any more. An open microphone
 * meant a person had joined, back when a listener's mic was closed; hot
 * auto-listen opens every listener's, so reading it that way would seat the
 * whole team in a room forever off one sentence. The mode carries the intent
 * instead — and it covers a room the person was already in, so a huddle joined
 * by hand is never handed back by a timer.
 *
 * The open mic therefore has a bounded life: the burst, plus the half minute an
 * answer might arrive in. That bound is the safety of the hot-mic decision.
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
 * of what a `releasing` marker used to be. `leaveCall` awaits the scribe before
 * `call.phase` moves, so between the decision and the seat going there are
 * ticks in which this client is still seated — and saying nothing owns the room
 * across them let the call dock flash over a room in the middle of
 * disappearing (ct-46031).
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
// A burst and a call are the same room; what separates them is whether a person
// decided to be in it. So the upgrade starts no machinery — nothing connects,
// nothing joins, no track is republished. The strip becomes the dock and the
// seat stops being on loan.

/**
 * Somebody stepped into this room on purpose — me, or the person I am talking
 * to. Idempotent, and deliberately not scoped to the burst: the call outlives
 * it, and so does this.
 */
export function markWalkieUpgraded(roomKey: string): void {
  if (walkieJoinedRoom(status) === roomKey) return;
  enterLiveRoom(roomKey, "call");
  // THE STAMP THAT ARRIVED A MOMENT TOO LATE. The release mutes a burst nobody
  // had stepped into yet, and the stamp for the step they took while the key
  // was still down lands after it — so the sender is in a call, told so in
  // words and a sound, with the microphone the upgrade exists to keep open
  // already closed. Only ever the mic this module itself closed, and only in
  // the room the stamp names, so a person who muted themselves stays muted.
  if (mutedByRelease === roomKey && inRoom(roomKey)) {
    mutedByRelease = null;
    void setMuted(false);
  }
  refresh();
}

/**
 * JOIN LIVE. The one gesture the whole upgrade exists for, and one click: the
 * person is already seated and already audible, so nothing here touches the
 * media plane except to put the camera back the way they left it.
 *
 * The stamp goes through the ordinary join path, which treats a room it is
 * already in as an intent rather than a no-op (callManager's
 * `applyDeliberateJoin`). That is what tells the OTHER side, whose surface
 * upgrades off the same roster row. The seat's clock stops with it.
 */
export async function joinWalkieLive(
  roomKey: string,
  /** Who is on the other end, when the surface that offered the button knows.
   *  Only the sentence uses it — "You joined Jordan" rather than "You joined
   *  the call" — so a caller that cannot name them still joins the same way. */
  opts: { name?: string | null } = {},
): Promise<void> {
  markWalkieUpgraded(roomKey);
  // SAID BEFORE THE JOIN. The answer to a press has to be immediate, the stamp
  // is a round trip away, and this side already knows what it did.
  announceJoin(roomKey, youJoinedText(opts.name));
  // THE SAME CUE ON BOTH SIDES. The far side hears it off the roster stamp
  // (hooks/useWalkieSync); nothing played it for the person who pressed the
  // button, so the one gesture that turns a burst into a call made no sound.
  soundWalkieJoined();
  await joinCall(roomKey, { intent: "deliberate", walkieJoin: true });
}

/**
 * END. The person pressed the red button: the call ends and the card goes
 * WITH it — no thirty second "still open" seat after a hang-up. The linger
 * exists so a burst can be answered; a hang-up is the opposite of an
 * invitation to answer. Any burst still open lands as the message it is.
 */
export async function endWalkie(): Promise<void> {
  if (burst) await endBurst();
  const held = status.liveRoom;
  if (status.incoming) emit({ incoming: null });
  await leaveCall();
  if (held) releaseRoom(held.key);
  refresh();
}

/**
 * SNOOZE. Shut the door now, not at the next push.
 *
 * The watcher reads the snooze too, so the door would close within a push
 * either way — but this is pressed to stop a voice playing at this second, and
 * "within a push" is not what the button promises. So the burst is dropped and
 * the seat handed straight back, which closes the hot microphone with it.
 *
 * The message is untouched: snoozing mutes a speaker, it never silences one.
 */
export function shutWalkieDoor(): void {
  const was = status.incoming;
  // The mode is deliberately NOT cleared. Snooze shuts a door; it does not
  // hang up a call somebody chose to be in, and a "not now" button ending a
  // call is the wrong reading of the word.
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

/**
 * TAKE THE SEAT SO A BURST CAN PLAY, WITH OR WITHOUT A MICROPHONE.
 *
 * Nobody pressed anything to get here, so the seat's job is to HEAR — and a
 * refused microphone used to cost exactly that. The join opened the device
 * because auto-listen is unmuted, the device threw, the join's own error path
 * tore the room down, and the strip went on saying a teammate was talking over
 * a silence with no room behind it. The one person this feature has to work
 * for on a machine with the microphone off got nothing at all.
 *
 * `intent: "listen"` is the whole fix on the media side: the mic is the part of
 * the join allowed to fail, and what is left is a seat that subscribes and
 * publishes nothing (callManager's `openMicForJoin`). The strip reads
 * `call.micDenied` and says so in its own words.
 *
 * The toast is the fix in reach. `mediaFailureReason` names the actual remedy —
 * the site-settings icon left of the address bar — and the walkie's error field
 * already carries exactly one toast per distinct message, so a person who has
 * blocked the microphone is told once how to unblock it rather than on every
 * burst.
 */
async function takeListeningSeat(roomKey: string): Promise<void> {
  await joinCall(roomKey, { intent: "listen" });
  if (!useInboxStore.getState().call.micDenied) return;
  emit({ error: await mediaFailureReason("microphone") });
}

let lastReport: { bursts: LiveBurstRow[]; doorOpen: boolean } = { bursts: [], doorOpen: false };
/** When this client started hearing the burst it is hearing now. The listening
 *  side's only measure of whether anything was actually said. */
let incomingSince = 0;

function applyReport(): void {
  const { bursts: rows, doorOpen } = lastReport;
  let current = pickLiveBurst(rows, Date.now());

  // MY OWN KEY IS DOWN. A teammate keying up in the SAME room is answering me,
  // and both voices belong in the room I am already holding: `incoming` is set
  // beside `sending`, the strip shows both directions, and each burst lands as
  // its own message in the order it was spoken. Nothing here opens a second
  // room — the seat is taken, `enterLiveRoom` keeps the mode mine, and the
  // microphone is already live.
  //
  // A burst somewhere ELSE is not ours to walk into: one pair of ears cannot
  // follow two rooms, and leaving mid-sentence to hear it would evict the
  // conversation I am in the middle of having. It waits as a message.
  //
  // This used to be a blanket early return, which meant the person who pressed
  // FIRST never learned that anybody had answered: the strip stayed a
  // one-directional "recording" while a second voice was already in the room.
  if (burst && current && current.roomKey !== burst.roomKey) current = null;

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
      // Claimed in the same push that publishes the burst, and claiming it is
      // all a teammate's burst arriving during our own hold-open has to do:
      // one room key replaces another with nothing in between.
      enterLiveRoom(incoming.roomKey, "listen");
      emit({ incoming });
      // Their voice gets a meter too, so a surface can animate the burst it is
      // hearing the same way it animates the one being spoken.
      pumpWalkieMeter();
      soundWalkieOpen();
      // My own burst is already carrying this room (`openRoomForBurst`), and it
      // is joining with the CLONE the recorder is reading. A second join for
      // the same key would supersede that one and publish a fresh microphone
      // instead, so the reply lets the burst do the seating.
      if (!inRoom(incoming.roomKey) && burst?.roomKey !== incoming.roomKey) {
        // HOT. Hearing someone means they can hear you — a walkie is not a
        // speaker, and half a channel is not a channel. The founder's decision,
        // overriding the muted auto-join this used to be.
        //
        // The DOOR is what makes it safe rather than reckless: nothing reaches
        // here unless the pref is open, the person is not busy, not snoozed, at
        // this machine, and not in some other call — and the strip says the mic
        // is open in words, with Mute one click away, the moment it happens.
        // The camera stays off, always.
        //
        // Only when the walkie is TAKING the seat. Somebody already sitting in
        // this room chose their own mute state, and opening a microphone a
        // person deliberately closed is the one thing the door cannot consent
        // to on their behalf.
        //
        // The unmute is the JOIN'S to write, not this line's. Saying it here
        // made `call.muted` a promise the media plane had not kept yet, and on
        // a browser with the microphone refused the strip spent the two
        // seconds before the failure landed claiming an open mic.
        void takeListeningSeat(incoming.roomKey);
      }
    }
  } else if (status.incoming) {
    // Their key came up, or the door closed while they were talking. Hold the
    // room briefly either way — an answer is the most likely next thing.
    //
    // Unless there was nothing to answer. A burst the sender threw away leaves
    // the same trace here as one that landed: the live row simply stops being
    // live, and this side cannot read the outcome. What it CAN measure is how
    // long it heard, which is the same question MIN_BURST_MS asks of the hand
    // on the key. Without it a brushed key seated the LISTENER in a call room
    // for half a minute too, under a strip claiming a conversation was open.
    const was = status.incoming;
    const heardMs = Date.now() - incomingSince;
    // NOBODY ENDED THIS ONE. A burst still marked live long past the sender's
    // own cap is a tab that died mid-word, not a hold that finished. There is
    // no half conversation to hold a room open for and nobody left to answer,
    // so the seat goes back now rather than after another half minute of open
    // microphone — the same judgement a brushed key gets, for the same reason.
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
      // Nothing was said yet, and a dying page cannot upload the recording, so
      // there is no message here — only a live row. The server refuses to
      // finalize one for the same reason ("a voice message needs audio or a
      // transcript").
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
    // The upgrade, for a headless rig: otherwise reachable only through a
    // button on a floating surface, and the release it changes (no mute, no
    // roger) is the one thing here a screenshot cannot show.
    markUpgraded: markWalkieUpgraded,
    joinLive: joinWalkieLive,
    joinedRoom: () => walkieJoinedRoom(getWalkieStatus()),
    end: endWalkie,
  };
}
