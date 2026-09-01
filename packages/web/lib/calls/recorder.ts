// The meeting recorder: press record, and the microphone in front of you
// becomes a transcript.
//
// It is the scribe with one track and no room. Somebody sits in a meeting —
// in person, on Zoom, on a phone on the desk — presses record, and their
// microphone is streamed to the recognizer exactly as a huddle's tracks are.
// Everything after capture is the pipeline that already exists: segments,
// silence-gap flushes, the summary and action items when it ends, the calls
// page, `cast calls`. Nothing downstream knows a recording from a huddle,
// which is the whole design.
//
// IT RECORDS FROM THE MICROPHONE, and the surfaces say so in those words. A
// meeting playing through the speakers is heard the way a person across the
// table is heard: well enough, and not as a direct feed. Nothing here claims
// otherwise.
//
// ON THE DESKTOP it also asks the shell for the computer's own audio (the
// loopback feed Chromium exposes through getDisplayMedia — main.js answers the
// request with `audio: "loopback"`). That is what makes a meeting in
// headphones recordable at all: the microphone cannot hear what only the
// person hears. Strictly best effort — refused screen permission, an old
// shell, a browser — and the recording is what it always was, the microphone.
// The status says which of the two actually happened (`systemAudio`), and the
// pill reads it.
//
// IT NEVER STARTS BY ITSELF. `startRecording` runs on a person's press and on
// nothing else. The meeting-detection popup (ct-46036) will call this same
// function — with an answer from the person as its gesture, never in place of
// one.
//
// Module singleton beside callManager and walkie, same pattern: one recording
// at a time on this machine, components read a small status snapshot through
// subscribe/getSnapshot, and no audio machinery goes anywhere near React.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { CALL_HEARTBEAT_MS, recRoomKey } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { uploadBlobToStorage } from "../uploadBlob";
import { mutateOnUnload } from "../keepaliveMutation";
import { createMicMeter, type MicMeter } from "./micMeter";
import { createScribeEngine, type ConvexHandle } from "./scribeEngine";
import { peekOsPermissions, permissionHint, refreshOsPermissions } from "../osPermissions";
import { isDesktop } from "../desktop";

const api = _api as any;

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping";

export type RecorderStatus = {
  phase: RecorderPhase;
  /** The transcript being written, which is also where the words are read. */
  transcriptId: string | null;
  /** Wall clock, for the elapsed counter. Zero while idle. */
  startedAt: number;
  /** Something the person should know: a refused microphone, a recognizer that
   *  will not start. Never a reason the recording stopped on its own — it does
   *  not stop on its own. */
  error: string | null;
  /** The last few things the recognizer made out, newest last. */
  tail: Array<{ speaker: string; text: string }>;
  /** The computer's own audio is being captured alongside the microphone
   *  (desktop loopback). False everywhere the shell cannot provide it. */
  systemAudio: boolean;
};

const IDLE: RecorderStatus = {
  phase: "idle",
  transcriptId: null,
  startedAt: 0,
  error: null,
  tail: [],
  systemAudio: false,
};

const engine = createScribeEngine();

let convex: ConvexHandle | null = null;
let snapshot: RecorderStatus = IDLE;
let phase: RecorderPhase = "idle";
let recTranscriptId: string | null = null;
let startedAt = 0;
let error: string | null = null;
const subscribers = new Set<() => void>();

let stream: MediaStream | null = null;
let meter: MicMeter | null = null;
let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let beatTimer: ReturnType<typeof setInterval> | null = null;
let sysStream: MediaStream | null = null;
let systemAudio = false;
// The audio file's mixing bowl: mic in at start, the loopback feed joined in
// whenever it arrives. Null when WebAudio is unavailable — the file is then
// the raw microphone stream, as it always was.
let mixCtx: AudioContext | null = null;
let mixDest: MediaStreamAudioDestinationNode | null = null;

/** One snapshot out of two sources — this module's own phase and the scribe
 *  engine's words — recomputed on either moving, so a React subscriber sees a
 *  stable object that changes exactly when something it renders changed. */
function publish() {
  const s = engine.getStatus();
  const next: RecorderStatus = {
    phase,
    transcriptId: recTranscriptId,
    startedAt,
    error: error ?? s.error,
    tail: s.tail,
    systemAudio,
  };
  if (
    next.phase === snapshot.phase &&
    next.transcriptId === snapshot.transcriptId &&
    next.startedAt === snapshot.startedAt &&
    next.error === snapshot.error &&
    next.tail === snapshot.tail &&
    next.systemAudio === snapshot.systemAudio
  ) {
    return;
  }
  snapshot = next;
  for (const cb of subscribers) cb();
}

engine.subscribe(publish);

export function bindRecorder(client: ConvexHandle): void {
  convex = client;
}

export function subscribeRecorder(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getRecorderStatus(): RecorderStatus {
  return snapshot;
}

/** The microphone's own level, for the pill's meter. Its own subscription for
 *  the reason micMeter documents: this number moves per animation frame. */
export function subscribeRecorderLevel(cb: () => void): () => void {
  // A meter only exists while a recording does, so a subscriber that outlives
  // one has to be re-pointed when the next starts. `levelSubscribers` is that
  // indirection: the pill subscribes once and every recording's meter feeds it.
  levelSubscribers.add(cb);
  return () => levelSubscribers.delete(cb);
}
const levelSubscribers = new Set<() => void>();
let dropMeterFeed: (() => void) | null = null;

export function getRecorderLevel(): number {
  return meter?.level() ?? 0;
}

function setPhase(next: RecorderPhase, err: string | null = null) {
  phase = next;
  error = err;
  publish();
}

/** What the browser will actually record, container first. Same ladder the
 *  walkie's voice notes use. */
function recorderMime(): string {
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported?.(mime)) return mime;
    } catch {}
  }
  return "";
}

function me(): { id: string; name: string } {
  const user = useInboxStore.getState().currentUser as any;
  return {
    id: String(user?._id ?? "me"),
    name: user?.name || user?.email || "Me",
  };
}

/**
 * Start recording. Returns the transcript id, or null if nothing started —
 * in which case the status carries a sentence saying why.
 *
 * Called from a person's press. The microphone is opened FIRST: a refusal
 * there is the common failure and it must not leave a transcript row behind
 * claiming a recording nobody is making.
 */
export async function startRecording(): Promise<string | null> {
  if (phase !== "idle") return recTranscriptId;
  if (!convex) {
    setPhase("idle", "Recording is not ready yet — reload the page.");
    return null;
  }
  setPhase("starting");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // A meeting in the room is what this is listening for, so the processing
      // that exists to isolate ONE near voice works against it: echo
      // cancellation subtracts what the speakers are playing, which here is
      // half the meeting. Automatic gain stays on — it is what lets somebody
      // across the table be heard at all.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch {
    // Name the actual remedy when the OS knows one (System Settings on the
    // desktop, the site setting in a browser).
    await refreshOsPermissions().catch(() => {});
    const hint = permissionHint("microphone", peekOsPermissions().microphone);
    setPhase("idle", hint ?? "Recording needs the microphone. Allow it and press record again.");
    return null;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopStream();
    setPhase("idle", "No microphone was available to record from.");
    return null;
  }

  // A fresh id per recording, minted here. The server treats an unclaimed id
  // as belonging to whoever starts on it, so this call is what makes the
  // recording ours (convex/callRooms, recordings section).
  const roomKey = recRoomKey(newRecId());
  let transcriptId: string | null = null;
  try {
    transcriptId = await engine.start({ convex, roomKey });
  } catch (err: any) {
    stopStream();
    setPhase("idle", String(err?.message ?? "Could not start the recording"));
    return null;
  }
  if (!transcriptId) {
    stopStream();
    setPhase("idle", "Could not start the recording");
    return null;
  }

  recTranscriptId = transcriptId;
  const who = me();
  engine.attach("mic", track, who.id, who.name);

  meter = createMicMeter(track);
  dropMeterFeed = meter.subscribe(() => {
    for (const cb of levelSubscribers) cb();
  });

  startAudioFile(buildFileStream(stream));

  // A recording holds its own lease: there is no room and no seat to keep it
  // alive, so this beat is what tells the server the tab is still here. Miss
  // it — the tab closed, the machine slept — and the orphan sweep ends the
  // transcript at the last beat, which is when the recording really stopped.
  beatTimer = setInterval(() => {
    if (!convex || !transcriptId) return;
    convex.mutation(api.transcripts.beat, { transcript_id: transcriptId }).catch(() => {});
  }, CALL_HEARTBEAT_MS);

  startedAt = Date.now();
  setPhase("recording");
  // The computer's own audio, where the shell can provide it. After the phase
  // flip so its guard can be one question, and deliberately not awaited: the
  // microphone must not wait on a screen-permission prompt.
  void addSystemAudio(transcriptId);
  return transcriptId;
}

/**
 * Stop, and land everything.
 *
 * Order is the point. The words are the artifact, so the transcript ends (and
 * its summary is scheduled) before the audio file is even looked at; the
 * upload happens afterwards and cannot cost anybody a transcript by failing.
 */
export async function stopRecording(): Promise<void> {
  // Only from a running recording. A press during `starting` would be racing
  // the microphone prompt, and there is nothing yet to stop — which is also
  // why no surface offers a stop button until the recording is running.
  if (phase !== "recording") return;
  const transcriptId = recTranscriptId;
  setPhase("stopping");

  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;

  // The audio file first, because closing the recorder is what produces the
  // last chunk — and stopping the microphone track before that would truncate
  // it. Neither of these two waits blocks the other's result.
  const blob = await finishAudioFile();
  // `graceful`: give the recognizer its couple of seconds to commit the
  // sentence somebody pressed stop right after.
  await engine.stop({ graceful: true });

  dropMeterFeed?.();
  dropMeterFeed = null;
  meter?.stop();
  meter = null;
  for (const cb of levelSubscribers) cb();
  stopStream();
  closeMix();
  startedAt = 0;
  recTranscriptId = null;
  systemAudio = false;
  setPhase("idle");

  if (blob && transcriptId && convex) {
    const storageId = await uploadBlobToStorage(convex, blob, blob.type);
    if (storageId) {
      await convex
        .mutation(api.transcripts.attachRecording, {
          transcript_id: transcriptId,
          storage_id: storageId,
        })
        .catch(() => {});
    }
  }
}

function stopStream() {
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  for (const t of sysStream?.getTracks() ?? []) t.stop();
  sysStream = null;
}

// ── system audio (desktop loopback) ─────────────────────────────────────────
//
// What the microphone cannot hear: a meeting playing into headphones. The
// desktop shell answers getDisplayMedia with the primary screen and Chromium's
// loopback audio feed (main.js setDisplayMediaRequestHandler); the video track
// is the toll of that API and is stopped on arrival. Everything is best
// effort: a refusal, a browser, an old shell, a denied Screen Recording
// permission — any of them just leaves the recording what it already is.

async function addSystemAudio(transcriptId: string): Promise<void> {
  if (!isDesktop()) return;
  // Not during a huddle: the loopback feed would capture our own call audio,
  // and a huddle's remote tracks are already transcribed by its own scribe.
  if (useInboxStore.getState().call.phase !== "idle") return;
  // A permission denied in System Settings makes the capture fail anyway;
  // skip the doomed attempt. "ask"/"unknown" go ahead — the attempt is what
  // raises the OS prompt the first time.
  if (peekOsPermissions().screen === "off") return;

  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    return;
  }
  for (const t of display.getVideoTracks()) t.stop();
  const track = display.getAudioTracks()[0];
  // The press this belongs to may be over by the time the permission prompt
  // was answered — a stopped recording must not reopen a capture.
  if (!track || phase !== "recording" || recTranscriptId !== transcriptId) {
    for (const t of display.getTracks()) t.stop();
    return;
  }

  sysStream = display;
  // A second recognizer pipe, beside "mic". One speaker label for the whole
  // feed: the recognizer keys speakers per track, and this track is "whatever
  // the computer played".
  engine.attach("system", track, "system", "Meeting audio");
  // Into the audio file's mix, mid-recording — WebAudio allows a source to
  // join a running graph.
  if (mixCtx && mixDest) {
    try {
      mixCtx.createMediaStreamSource(new MediaStream([track])).connect(mixDest);
    } catch {}
  }
  // With a direct feed in hand, the microphone's job narrows to the person in
  // the room — ask the platform to subtract what the speakers are playing, so
  // a meeting on speakers is not transcribed twice. Best effort: with
  // headphones there is nothing to subtract and this changes nothing.
  try {
    await stream?.getAudioTracks()[0]?.applyConstraints({ echoCancellation: true });
  } catch {}
  // The OS can end the feed on its own (permission revoked mid-recording).
  // The recording carries on as the microphone, and says so.
  track.onended = () => {
    if (recTranscriptId !== transcriptId) return;
    engine.detach("system");
    systemAudio = false;
    publish();
  };
  systemAudio = true;
  publish();
}

function buildFileStream(mic: MediaStream): MediaStream {
  try {
    if (typeof AudioContext !== "function") return mic;
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(dest);
    mixCtx = ctx;
    mixDest = dest;
    return dest.stream;
  } catch {
    closeMix();
    return mic;
  }
}

function closeMix() {
  mixCtx?.close().catch(() => {});
  mixCtx = null;
  mixDest = null;
}

// ── the audio file ──────────────────────────────────────────────────────────
//
// Best effort throughout, and separate from the transcript on purpose: a
// browser with no MediaRecorder, a codec it will not encode, an upload that
// fails on a bad connection — none of those may cost anyone the words they
// recorded. Chunks are held in memory and uploaded once, at stop, because a
// meeting is minutes rather than hours and a streaming upload would be a
// second failure mode for no gain at this length.

function startAudioFile(source: MediaStream) {
  chunks = [];
  mediaRecorder = null;
  try {
    if (typeof MediaRecorder !== "function") return;
    const mime = recorderMime();
    const rec = new MediaRecorder(source, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    // A chunk a second, so a tab that dies has lost seconds of audio rather
    // than the whole meeting — the transcript survives either way.
    rec.start(1000);
    mediaRecorder = rec;
  } catch {
    mediaRecorder = null;
  }
}

/** Close the recorder and hand back what it captured, or null. Bounded: a
 *  recorder that never fires `stop` must not hold the person's press. */
function finishAudioFile(): Promise<Blob | null> {
  const rec = mediaRecorder;
  mediaRecorder = null;
  if (!rec || rec.state === "inactive") {
    const blob = chunks.length ? new Blob(chunks, { type: chunks[0].type }) : null;
    chunks = [];
    return Promise.resolve(blob);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const blob = chunks.length ? new Blob(chunks, { type: chunks[0].type }) : null;
      chunks = [];
      resolve(blob);
    };
    rec.onstop = done;
    setTimeout(done, 3_000);
    try {
      rec.stop();
    } catch {
      done();
    }
  });
}

function newRecId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // Old browsers and test environments. The id only has to be unguessable
  // enough that nobody lands on somebody else's by accident — it grants
  // nothing on its own (the transcript's owner is the rule).
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// The last word of a page that is going away. The lease already covers this —
// the sweep ends the transcript at the final beat — but a summary that arrives
// in seconds rather than in two minutes is worth one keepalive request.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (phase !== "recording" || !recTranscriptId) return;
    mutateOnUnload(_api.transcripts.stop, { transcript_id: recTranscriptId });
  });
}

// Dev console / e2e access to the real module instance (a dynamic import() of
// this file would be a second instance with its own empty state — the same
// trap __callManager documents).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__recorder = {
    start: startRecording,
    stop: stopRecording,
    status: getRecorderStatus,
    level: getRecorderLevel,
    bound: () => !!convex,
  };
}
