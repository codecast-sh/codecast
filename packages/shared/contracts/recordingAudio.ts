// What a phone records a meeting as, and how long one file may run.
//
// A recorder has one ceiling it cannot negotiate: the transcription endpoint
// refuses a file over 25 MB, and an m4a cannot be cut up afterwards to get
// under it. There is no audio decoder in a Convex action, and a byte range of
// an MP4 container is not a playable file — so "split it server side if it is
// too big" is not a thing that can be built where the bytes land. The ceiling
// has to be respected where the bytes are MADE, on the phone: pick an encoding
// whose byte rate leaves room for any real meeting, and stop the recorder
// before the file outgrows the endpoint that has to read it.
//
// The settings below are tuned for speech, not music, which is what buys the
// room. Whisper-family models resample everything to 16 kHz mono anyway, so a
// 44.1 kHz stereo capture spends four times the bytes to deliver the same
// words — and on a phone those bytes are somebody's cellular upload. At 24 kbps
// mono an hour of meeting is about 10 MB and the ceiling lands past two hours;
// at the platform's HIGH_QUALITY preset it would land at twenty-six minutes.

/** Matches the transcription model's own internal rate, so nothing resamples. */
export const RECORDING_SAMPLE_RATE = 16_000;
/** One microphone in a room hears one channel of information. */
export const RECORDING_CHANNELS = 1;
/** AAC at this rate is telephone-clear speech, which is what a transcript and
 *  a replay of a meeting both need. */
export const RECORDING_BIT_RATE = 24_000;

/** Bytes of file per second of wall clock. AAC holds its nominal rate closely
 *  enough at meeting length that the container header is noise. */
export const RECORDING_BYTES_PER_SECOND = RECORDING_BIT_RATE / 8;

/** The transcription endpoint (`/v1/audio/transcriptions`) rejects anything
 *  larger, whatever the model. */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * How long one file may run before it outgrows the transcriber.
 *
 * A function of the byte rate rather than a written-down number of minutes, so
 * changing the encoding moves the ceiling with it instead of leaving a stale
 * constant that silently starts lying. The margin covers the container
 * overhead and the encoder's drift above its nominal bitrate: the number this
 * returns is a limit the recorder STOPS at, so landing just over the real cap
 * would cost somebody the transcript of a meeting they already sat through.
 */
export function maxRecordingMs(
  bytesPerSecond: number = RECORDING_BYTES_PER_SECOND,
  maxBytes: number = TRANSCRIBE_MAX_BYTES,
  margin = 0.9,
): number {
  if (!(bytesPerSecond > 0)) return 0;
  return Math.floor(((maxBytes * margin) / bytesPerSecond) * 1000);
}

/** The ceiling for the encoding above. */
export const MAX_RECORDING_MS = maxRecordingMs();

// ── The level meter ───────────────────────────────────────────────────────

/** Below this a measurement is a room, not a voice. */
export const METER_FLOOR_DB = -50;
/** Above this the meter is pinned. */
export const METER_CEIL_DB = -6;

/**
 * A recorder's level reading, in dBFS, as meter travel (0..1).
 *
 * The band is chosen so speech lives in the upper half and the gaps between
 * words visibly move — a meter that sits at nine tenths through a whole
 * meeting tells nobody whether the microphone is working, which is the only
 * question it exists to answer.
 *
 * The browser walkie's `meterLevel` (web/lib/calls/walkie.ts) is the same band
 * reached from the other side: it measures an RMS amplitude and converts to
 * decibels first. The two should end up sharing this function, but walkie.ts
 * is being rewritten by the walkie work right now and a drive-by edit there
 * would collide; this is the canonical copy for anything new.
 */
export function meterLevelFromDb(db: number | undefined | null): number {
  if (db === undefined || db === null || Number.isNaN(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}
