// The phone as a meeting recorder.
//
// Somebody puts the phone on the table, presses record, and the microphone
// hears the room. The words are not read here — React Native has no
// AudioContext and no way to tap a microphone as samples, so there is no live
// recognizer to stream to the way the browser recorder does. What the phone
// does is capture a file and hand it to the server, which reads the words out
// of it (convex/transcripts.ts transcribeRecording) and then runs the same
// summary and action items every huddle gets. That is why this module has a
// level meter and a clock and no live transcript: showing words the phone
// cannot produce would be a lie about what is happening.
//
// A MODULE SINGLETON, beside callManager and ringtone, for the same reason
// they are: the recording has to outlive the screen. Somebody starts a
// recording, backgrounds the app and puts the phone face down for an hour —
// the capture, the server lease and the length ceiling all have to keep
// running with no React tree mounted. UIBackgroundModes already carries
// "audio" (the huddle needed it), which is what keeps the process alive with
// the screen locked.

import { Platform } from 'react-native';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import type { ConvexReactClient } from 'convex/react';
import {
  CALL_HEARTBEAT_MS,
  MAX_RECORDING_MS,
  meterLevelFromDb,
  RECORDING_BIT_RATE,
  RECORDING_CHANNELS,
  RECORDING_SAMPLE_RATE,
  recRoomKey,
} from '@codecast/shared/contracts';
import { getCallSnapshot } from './calls/callManager';
import { uploadUriToStorage } from './uploadToStorage';

// expo-audio is a NATIVE dependency, lazily required and probed exactly the
// way lib/calls/ringtone.ts does it: a JS bundle (OTA or dev server) newer
// than the installed binary must degrade to an honest message, never crash at
// import. The package's inner requireNativeModule fires on first property
// access, outside any try we could wrap around the import.
let audio: typeof import('expo-audio') | null | undefined;
function getAudio() {
  if (audio !== undefined) return audio;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireOptionalNativeModule } = require('expo');
    audio = requireOptionalNativeModule('ExpoAudio') ? require('expo-audio') : null;
  } catch {
    audio = null;
  }
  return audio;
}

export type RecorderPhase =
  /** Nothing running. The button says Record. */
  | 'idle'
  /** Asking for the microphone and opening the transcript. */
  | 'starting'
  /** The microphone is live. */
  | 'recording'
  /** Stopped, and the file is on its way to the server. */
  | 'finishing'
  /** The last attempt did not work, and the message says why. */
  | 'error';

export type RecorderSnapshot = {
  phase: RecorderPhase;
  /** Wall clock at which capture began; the screen derives the elapsed time
   *  from it rather than the recorder pushing a new snapshot every second. */
  startedAt: number | null;
  /** The recording this is, once the server has opened it. The screen opens
   *  its detail page after a stop. */
  transcriptId: string | null;
  /** Plain words for the person, not a stack trace. */
  error: string | null;
  /** Set when capture ended because the file reached the length a
   *  transcription can still read. */
  stoppedAtLimit: boolean;
};

const IDLE: RecorderSnapshot = {
  phase: 'idle',
  startedAt: null,
  transcriptId: null,
  error: null,
  stoppedAtLimit: false,
};

let snapshot: RecorderSnapshot = IDLE;
const listeners = new Set<() => void>();

export function subscribeRecorder(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getRecorderSnapshot(): RecorderSnapshot {
  return snapshot;
}

function set(patch: Partial<RecorderSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

// ── The level meter ───────────────────────────────────────────────────────
// Kept off the snapshot deliberately. It moves several times a second, and a
// snapshot push would re-render the whole screen at that rate for one bar; the
// meter component subscribes here on its own and writes an Animated.Value
// imperatively, so a moving level costs no React renders at all.

let level = 0;
const levelListeners = new Set<(v: number) => void>();

export function subscribeLevel(cb: (v: number) => void): () => void {
  levelListeners.add(cb);
  cb(level);
  return () => levelListeners.delete(cb);
}

export function getLevel(): number {
  return level;
}

function setLevel(v: number): void {
  level = v;
  levelListeners.forEach((l) => l(v));
}

// ── The run ───────────────────────────────────────────────────────────────

type Run = {
  recorder: any;
  transcriptId: Id<'transcripts'>;
  convex: ConvexReactClient;
  beat: ReturnType<typeof setInterval> | null;
  meter: ReturnType<typeof setInterval> | null;
  limit: ReturnType<typeof setTimeout> | null;
};

let run: Run | null = null;

/** Whatever this run still holds onto, released. Called on every exit — a
 *  microphone left open is the failure a person notices in the status bar. */
function teardown(): void {
  if (!run) return;
  if (run.beat) clearInterval(run.beat);
  if (run.meter) clearInterval(run.meter);
  if (run.limit) clearTimeout(run.limit);
  run.beat = run.meter = run.limit = null;
  setLevel(0);
}

/** What the file is. See shared/contracts/recordingAudio for why it is speech
 *  quality rather than the platform's HIGH_QUALITY preset: the transcriber
 *  refuses a file over 25 MB and an m4a cannot be cut up afterwards, so the
 *  encoding is what buys a meeting room to run long in. */
function recordingOptions(a: NonNullable<typeof audio>): any {
  const common = {
    extension: '.m4a',
    sampleRate: RECORDING_SAMPLE_RATE,
    numberOfChannels: RECORDING_CHANNELS,
    bitRate: RECORDING_BIT_RATE,
    isMeteringEnabled: true,
  };
  // The package flattens these per platform inside its hook, which is not
  // exported; a module singleton cannot use the hook, so it flattens the same
  // way here.
  return Platform.OS === 'ios'
    ? {
        ...common,
        outputFormat: a.IOSOutputFormat.MPEG4AAC,
        audioQuality: a.AudioQuality.MEDIUM,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      }
    : { ...common, outputFormat: 'mpeg4', audioEncoder: 'aac' };
}

/** A huddle owns the audio session while it runs, and expo-audio's mode change
 *  would pull it out from under LiveKit — the same rule that keeps the ring
 *  silent during a call (lib/calls/ringtone.ts). */
function callOwnsAudio(): boolean {
  const p = getCallSnapshot().phase;
  return p === 'connecting' || p === 'connected';
}

/**
 * Start recording the room.
 *
 * The order is deliberate. Permission first, so a refusal costs nothing.
 * Then the transcript, because it is the artifact and there is nowhere to put
 * a recording without one — and if the server refuses (an old deployment has
 * no idea what a rec key is), the microphone was never taken. The microphone
 * last.
 */
export async function startRecording(convex: ConvexReactClient): Promise<void> {
  if (snapshot.phase === 'starting' || snapshot.phase === 'recording' || snapshot.phase === 'finishing') {
    return;
  }
  set({ ...IDLE, phase: 'starting' });
  const a = getAudio();
  if (!a) {
    set({ phase: 'error', error: 'Recording needs a newer version of the app.' });
    return;
  }
  if (callOwnsAudio()) {
    set({ phase: 'error', error: 'Leave the huddle first — a call is using the microphone.' });
    return;
  }
  let transcriptId: Id<'transcripts'> | null = null;
  let recorder: any = null;
  try {
    const granted =
      (await a.getRecordingPermissionsAsync()).granted ||
      (await a.requestRecordingPermissionsAsync()).granted;
    if (!granted) {
      set({ phase: 'error', error: 'Codecast needs the microphone to record. Turn it on in Settings.' });
      return;
    }
    const started = await convex.mutation(api.transcripts.start, {
      room_key: recRoomKey(newRecordingId()),
    });
    transcriptId = started.transcript_id;

    // playsInSilentMode so the silent switch does not silence a capture
    // somebody deliberately started; shouldPlayInBackground so a locked screen
    // keeps recording, which is the whole difference between a meeting
    // recorder and a toy.
    await a.setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });
    recorder = new (a.AudioModule as any).AudioRecorder(recordingOptions(a));
    await recorder.prepareToRecordAsync();
    recorder.record();
  } catch (err) {
    // Anything that failed after the transcript opened leaves a live row the
    // orphan sweep would eventually close on its own; closing it here keeps
    // an abandoned attempt out of somebody's history in the meantime.
    if (transcriptId) {
      await convex.mutation(api.transcripts.stop, { transcript_id: transcriptId }).catch(() => {});
    }
    try {
      recorder?.stop?.();
    } catch {}
    await releaseAudioSession();
    set({ phase: 'error', error: recordingStartMessage(err) });
    return;
  }

  // Unreachable: the try assigned it or the catch returned. The check exists
  // because a narrowing made inside a try does not survive the block.
  if (!transcriptId) return;
  const active: Run = { recorder, transcriptId, convex, beat: null, meter: null, limit: null };
  run = active;
  set({
    phase: 'recording',
    startedAt: Date.now(),
    transcriptId: String(transcriptId),
    error: null,
    stoppedAtLimit: false,
  });

  // The server lease. A recording has no room and therefore no seat leases, so
  // this is the only thing telling the orphan sweep it is still going; without
  // it the sweep ends the recording two minutes in.
  active.beat = setInterval(() => {
    const id = run?.transcriptId;
    if (id) void convex.mutation(api.transcripts.beat, { transcript_id: id }).catch(() => {});
  }, CALL_HEARTBEAT_MS);

  active.meter = setInterval(() => {
    try {
      setLevel(meterLevelFromDb(run?.recorder?.getStatus?.()?.metering));
    } catch {
      setLevel(0);
    }
  }, 250);

  // Stop before the file outgrows what a transcription can read. Cutting it
  // here costs the tail of a very long meeting; not cutting it costs the words
  // of the whole thing, and only after the person has already sat through it.
  active.limit = setTimeout(() => {
    set({ stoppedAtLimit: true });
    void stopRecording();
  }, MAX_RECORDING_MS);
}

/**
 * Stop, and get the recording to the server.
 *
 * The transcript ends FIRST, before the audio file is even looked at. It is
 * the artifact — the words, the summary, the action items — and a failed
 * upload must never be able to cost somebody the meeting they recorded.
 * Resolves to the recording's id so the caller can open it.
 */
export async function stopRecording(): Promise<string | null> {
  const active = run;
  if (!active || snapshot.phase !== 'recording') return null;
  set({ phase: 'finishing' });
  teardown();
  run = null;

  let uri: string | null = null;
  try {
    await active.recorder.stop();
    uri = active.recorder.uri ?? null;
  } catch {
    // A capture that could not be closed still has a transcript to end.
  }
  await releaseAudioSession();
  await active.convex
    .mutation(api.transcripts.stop, { transcript_id: active.transcriptId })
    .catch(() => {});

  const id = String(active.transcriptId);
  if (!uri) {
    set({ phase: 'error', error: 'The recording did not save, so there are no words to read.', transcriptId: id });
    return id;
  }
  // One retry, because on a phone this file IS the recording: without it the
  // server has nothing to read and the meeting comes back empty.
  const storageId =
    (await uploadUriToStorage(active.convex, uri, 'audio/mp4')) ??
    (await uploadUriToStorage(active.convex, uri, 'audio/mp4'));
  if (!storageId) {
    set({
      phase: 'error',
      error: 'The audio could not be uploaded, so this recording has no words. Check your connection.',
      transcriptId: id,
    });
    return id;
  }
  // This is what starts the server reading the words; the recording sits on
  // "transcribing" until they land.
  await active.convex
    .mutation(api.transcripts.attachRecording, {
      transcript_id: active.transcriptId,
      storage_id: storageId as Id<'_storage'>,
    })
    .catch(() => {});
  set({ ...IDLE, transcriptId: id });
  return id;
}

/** Clear a failure the person has read, so the button goes back to Record. */
export function dismissRecorderError(): void {
  if (snapshot.phase === 'error') set({ ...IDLE });
}

/** Hand the audio session back. Leaving it in recording mode keeps the phone
 *  routed for capture — a quiet earpiece instead of the speaker — long after
 *  the recording ended. */
async function releaseAudioSession(): Promise<void> {
  try {
    await getAudio()?.setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
  } catch {}
}

/** The id half of the room key. `crypto.randomUUID` is not in Hermes, and the
 *  parser bounds the shape rather than trusting it (shared/callRoomKeys), so
 *  this only has to be unguessable and well formed. */
function newRecordingId(): string {
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${hex()}-${hex()}-${hex()}-${hex()}`;
}

/** A start failure the person can act on. The server's refusal of a rec key
 *  reads as a malformed room to anyone who has not deployed the recorder yet,
 *  which is exactly the case worth naming. */
function recordingStartMessage(err: unknown): string {
  const text = String(err);
  if (/Cannot transcribe this room|malformed|Not authenticated/i.test(text)) {
    return 'The server would not open a recording. It may need updating.';
  }
  return 'Recording could not start.';
}

// Dev-only harness hook, the same convention as __call and __ring: the
// simulator run drives the screen's states over the Hermes inspector, which is
// the only way to see them on a machine that must never open a microphone.
// __DEV__ is false in every release build, so none of this ships.
if (__DEV__) {
  (global as any).__recorder = {
    snapshot: getRecorderSnapshot,
    level: getLevel,
    stop: stopRecording,
    /** Paint a state without a microphone. Screenshots only — it moves the
     *  snapshot and nothing else, so no capture is ever running behind it. */
    preview: (patch: Partial<RecorderSnapshot>) => set(patch),
    previewLevel: (v: number) => setLevel(v),
  };
}
