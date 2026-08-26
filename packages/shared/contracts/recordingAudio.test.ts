import { describe, expect, test } from "bun:test";
import {
  MAX_RECORDING_MS,
  METER_CEIL_DB,
  METER_FLOOR_DB,
  RECORDING_BIT_RATE,
  RECORDING_BYTES_PER_SECOND,
  RECORDING_CHANNELS,
  RECORDING_SAMPLE_RATE,
  TRANSCRIBE_MAX_BYTES,
  maxRecordingMs,
  meterLevelFromDb,
} from "./recordingAudio";

// The recorder stops at a length rather than splitting a long file, because an
// m4a cannot be split: there is no audio decoder in a Convex action and a byte
// range of an MP4 container is not a playable file. That makes this arithmetic
// load bearing — it is the only thing standing between a two hour meeting and
// a transcription request the endpoint refuses.
describe("the length a recording may run to", () => {
  test("a file recorded to the ceiling still fits the transcriber", () => {
    const bytes = (MAX_RECORDING_MS / 1000) * RECORDING_BYTES_PER_SECOND;
    expect(bytes).toBeLessThan(TRANSCRIBE_MAX_BYTES);
  });

  test("the margin is real, not decorative", () => {
    // AAC drifts above its nominal bitrate and the container costs something.
    // Landing at 99% of the cap would fail for real files, and the failure is
    // discovered only after somebody has sat through the whole meeting.
    const bytes = (MAX_RECORDING_MS / 1000) * RECORDING_BYTES_PER_SECOND;
    expect(bytes).toBeLessThan(TRANSCRIBE_MAX_BYTES * 0.95);
  });

  test("it covers a meeting nobody would call short", () => {
    expect(MAX_RECORDING_MS).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  test("the ceiling moves with the encoding instead of going stale", () => {
    // The point of taking the byte rate as an argument: raising the bitrate
    // must shorten the recording, automatically. A written-down number of
    // minutes would quietly start lying the first time somebody tuned the
    // encoder.
    const fatter = maxRecordingMs(RECORDING_BYTES_PER_SECOND * 4);
    expect(fatter).toBe(Math.floor(MAX_RECORDING_MS / 4));
  });

  test("the platform's HIGH_QUALITY preset is what this encoding avoids", () => {
    // 44.1 kHz stereo at 128 kbps — the preset the recorder does NOT use.
    // Its ceiling lands under half an hour, which for a meeting recorder is
    // not a limit, it is a defect.
    expect(maxRecordingMs(128_000 / 8)).toBeLessThan(30 * 60 * 1000);
  });

  test("a nonsensical byte rate yields no time rather than infinity", () => {
    expect(maxRecordingMs(0)).toBe(0);
    expect(maxRecordingMs(-1)).toBe(0);
  });

  test("the encoding is the speech shape the ceiling is computed from", () => {
    expect(RECORDING_CHANNELS).toBe(1);
    expect(RECORDING_SAMPLE_RATE).toBe(16_000);
    expect(RECORDING_BYTES_PER_SECOND).toBe(RECORDING_BIT_RATE / 8);
  });
});

describe("meterLevelFromDb", () => {
  test("the band's ends are the meter's ends", () => {
    expect(meterLevelFromDb(METER_FLOOR_DB)).toBe(0);
    expect(meterLevelFromDb(METER_CEIL_DB)).toBe(1);
  });

  test("silence and clipping are clamped rather than drawn off the bar", () => {
    expect(meterLevelFromDb(-160)).toBe(0);
    expect(meterLevelFromDb(0)).toBe(1);
  });

  test("speech lands in the upper half, where a moving bar is legible", () => {
    // A person talking a foot from a phone reads around -20 dBFS.
    expect(meterLevelFromDb(-20)).toBeGreaterThan(0.5);
    // A quiet room does not.
    expect(meterLevelFromDb(-45)).toBeLessThan(0.2);
  });

  test("no reading is no level, never NaN on the bar", () => {
    expect(meterLevelFromDb(undefined)).toBe(0);
    expect(meterLevelFromDb(null)).toBe(0);
    expect(meterLevelFromDb(NaN)).toBe(0);
  });
});
