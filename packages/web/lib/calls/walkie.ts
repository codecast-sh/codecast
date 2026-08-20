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
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Track } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";
import { newChatMessageClientId } from "../../store/chatSlice";
import { getRoom, joinCall, leaveCall, setMuted } from "./callManager";
import { openAsrPipe, type AsrPipe } from "./asrPipe";
import { uploadBlobToStorage } from "../uploadBlob";
import { soundWalkieOpen } from "../sounds";

const api = _api as any;

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

/** Below this, the key was brushed rather than held: nothing was said. */
const MIN_BURST_MS = 700;
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
  transcript: string;
};

export type WalkieIncoming = {
  channelId: string;
  messageId: string;
  roomKey: string;
  fromUserId: string;
  fromName: string;
};

export type WalkieStatus = {
  /** What this client is transmitting right now. */
  sending: WalkieSending | null;
  /** The teammate this client is currently listening to, live. */
  incoming: WalkieIncoming | null;
  /** The room is being held open after a burst until this moment. */
  lingerUntil: number | null;
  /** Why push-to-talk cannot be used; null when it can. */
  unavailable: null | "another-call" | "not-ready";
  /** True when holding the key would answer someone — the reply affordance. */
  canReply: boolean;
  error: string | null;
};

let status: WalkieStatus = {
  sending: null,
  incoming: null,
  lingerUntil: null,
  unavailable: "not-ready",
  canReply: false,
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
    next.lingerUntil === status.lingerUntil &&
    next.unavailable === status.unavailable &&
    next.canReply === status.canReply &&
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

/** The room the walkie considers its own right now: the one being talked into,
 *  the one being listened to, or the one still held open after a burst. */
function walkieRoomKey(): string | undefined {
  return burst?.roomKey ?? status.incoming?.roomKey ?? lingerRoomKey ?? undefined;
}

/** Recompute what the UI may offer. Called whenever the world moves. */
function refresh() {
  emit({ unavailable: walkieBlockedFor(walkieRoomKey()) });
}

function localMicTrack(): MediaStreamTrack | null {
  const pub = getRoom()?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track?.mediaStreamTrack;
  return track && track.readyState === "live" ? track : null;
}

// ── the burst ───────────────────────────────────────────────────────────────

type Burst = {
  channelId: string;
  roomKey: string;
  clientId: string;
  messageId: string | null;
  startedAt: number;
  transcript: string;
  pushed: string;
  pushedAt: number;
  mime: string;
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
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let lingerRoomKey: string | null = null;

function publishSending(b: Burst | null) {
  emit({
    sending: b
      ? {
          channelId: b.channelId,
          roomKey: b.roomKey,
          clientId: b.clientId,
          messageId: b.messageId,
          startedAt: b.startedAt,
          transcript: b.transcript,
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
  const text = b.transcript.trim();
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
 * Hold to talk. Returns when the burst is fully set up (mic live, recorder and
 * recognizer running, server row open) — a caller that just wants to key the
 * mic can ignore the promise; `endBurst` awaits it either way, so a press
 * shorter than the setup is still cancelled correctly.
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
  clearLinger();

  const clientId = newChatMessageClientId();
  const b: Burst = {
    channelId,
    roomKey,
    clientId,
    messageId: null,
    startedAt: Date.now(),
    transcript: "",
    pushed: "",
    // The row is as fresh as the burst is old until the first push lands.
    pushedAt: Date.now(),
    mime: recorderMime(),
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
  emit({ error: null, unavailable: null });
  publishSending(b);

  b.ready = (async () => {
    try {
      // Hold the mic OPEN for as long as the key is down. joinCall publishes in
      // whatever mute state the store carries, so the intent is written first.
      if (inRoom(roomKey)) await setMuted(false);
      else {
        useInboxStore.getState().setCallState({ muted: false });
        await joinCall(roomKey);
      }
      if (b.done) return;
      const track = localMicTrack();
      if (!track) {
        emit({ error: useInboxStore.getState().call.error ?? "Microphone unavailable" });
        await abortBurst(b);
        return;
      }
      startRecording(b, track);
      b.pipe = openAsrPipe({
        convex: convex!,
        roomKey,
        track,
        clock: () => Date.now() - b.startedAt,
        events: {
          onUtterance: ({ text }) => {
            b.transcript = b.transcript ? `${b.transcript} ${text}` : text;
            publishSending(b);
            pushTranscript(b, true);
          },
          // A recognizer that failed is a burst without words, not a failed
          // burst: the audio is still live and still recorded.
          onFailed: () => {},
          onDropped: () => {},
        },
      });
      b.pushTimer = setInterval(() => pushTranscript(b), TRANSCRIPT_PUSH_MS);
      // The cap releases the key on the user's behalf: the burst lands as the
      // message it already is, and pressing again opens the next one.
      b.maxTimer = setTimeout(() => void endBurst(), MAX_BURST_MS);

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

/** Release. Lands the burst as a message, or throws it away if nothing was
 *  said. Safe to call twice — the max-length cap releases the key first, and
 *  the hand coming off it afterwards finds nothing left to do. */
export async function endBurst(): Promise<void> {
  const b = burst;
  if (!b) return;
  await finishBurst(b);
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

function teardownBurst(b: Burst) {
  b.done = true;
  if (b.pushTimer) clearInterval(b.pushTimer);
  if (b.maxTimer) clearTimeout(b.maxTimer);
  b.pushTimer = null;
  b.maxTimer = null;
  b.pipe?.close();
  b.pipe = null;
}

async function finishBurst(b: Burst): Promise<void> {
  if (b.done) return;
  // A press shorter than its own setup: let the setup finish so there is a
  // server row to land or cancel, then land it.
  await b.ready;
  if (b.done) return;
  teardownBurst(b);
  const durationMs = Date.now() - b.startedAt;
  const blob = await stopRecording(b);
  await setMuted(true);
  if (burst === b) {
    burst = null;
    publishSending(null);
  }

  const transcript = b.transcript.trim();
  const tooShort = durationMs < MIN_BURST_MS;
  const empty = !transcript && !blob;
  if (tooShort || empty) {
    // Sub-second, or a burst with neither words nor audio: a key somebody
    // brushed. The row never notified and never counted, so it simply goes.
    if (b.messageId && convex) {
      await convex.mutation(api.chat.cancelVoiceBurst, { message_id: b.messageId }).catch(() => {});
    }
    useInboxStore.getState().dropVoiceBurstRow({ clientId: b.clientId, messageId: b.messageId });
    beginLinger(b.roomKey);
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
    beginLinger(b.roomKey);
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
  } else {
    emit({ error: "Could not send the voice message" });
    // Only a burst the server confirmed it threw away may be taken off this
    // screen. "unresolved" means the network answered nothing, and the row is
    // still live over there: the orphan sweep will land it (with the words
    // already streamed into it) or discard it, and the channel's own sync is
    // what tells this client which. Erasing it here would be the one outcome
    // the codebase refuses — gone from the sender's screen, present on
    // everyone else's.
    if (outcome === "cancelled") {
      useInboxStore.getState().dropVoiceBurstRow({ clientId: b.clientId, messageId: b.messageId });
    }
  }
  beginLinger(b.roomKey);
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

// ── linger ──────────────────────────────────────────────────────────────────
//
// A burst is one half of a conversation. Leaving the room the instant the key
// comes up would mean the answer arrives at an empty room — so the room stays
// open, MUTED, for half a minute. The receiver holding their own key keeps it
// alive; nobody doing anything lets it close.
//
// Occupancy is deliberately NOT consulted here. Both sides linger, so "someone
// else is still in the room" is true of every burst and would hold the pair in
// an open room forever, each waiting for the other to leave. Engagement is the
// honest signal: talking, being talked to, or a mic the person opened.

function clearLinger() {
  if (lingerTimer) clearTimeout(lingerTimer);
  lingerTimer = null;
  lingerRoomKey = null;
  emit({ lingerUntil: null });
}

function beginLinger(roomKey: string) {
  clearLinger();
  if (!inRoom(roomKey)) return;
  lingerRoomKey = roomKey;
  emit({ lingerUntil: Date.now() + LINGER_MS });
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    const key = lingerRoomKey;
    lingerRoomKey = null;
    emit({ lingerUntil: null });
    if (!key || !inRoom(key)) return;
    // Engaged: still talking, still being talked to, or the user opened their
    // own mic in the dock. An engaged room is a huddle now, and a huddle is
    // left by hand.
    if (burst || status.incoming) return;
    if (!callState().muted) return;
    void leaveCall();
  }, LINGER_MS);
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
      };
      clearLinger();
      emit({ incoming });
      soundWalkieOpen();
      if (!inRoom(incoming.roomKey)) {
        // Muted: hearing someone is not answering them.
        useInboxStore.getState().setCallState({ muted: true });
        void joinCall(incoming.roomKey);
      }
    }
  } else if (status.incoming) {
    // Their key came up (the row is no longer live) or the door closed while
    // they were talking. Hold the room briefly either way — an answer is the
    // most likely next thing to happen.
    const was = status.incoming;
    emit({ incoming: null });
    beginLinger(was.roomKey);
  }
  refresh();
}

// Dev console / e2e access to the real module instance, exactly as callManager
// and the scribe expose theirs (a dynamic import() of this file would be a
// second instance with its own empty state).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__walkie = {
    status: getWalkieStatus,
    startBurst,
    endBurst,
    observe: observeWalkie,
    blockedFor: walkieBlockedFor,
    bound: () => !!convex,
  };
}
