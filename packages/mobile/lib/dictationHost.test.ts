// The phone's dictation host stops at each slow step once nobody wants the
// recording (cancelled, or a huddle took the microphone): after the permission
// prompt, after the audio session flips, and once the mic tap opens. An
// abandoned start then never flips the session for recording, opens a tap or
// mints a key, so a call connecting meanwhile keeps the microphone to itself.
import { beforeEach, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let permission: () => Promise<{ granted: boolean }> = async () => ({ granted: true });
let audioMode: () => Promise<void> = async () => {};
const audio = {
  getRecordingPermissionsAsync: () => permission(),
  requestRecordingPermissionsAsync: () => permission(),
  setAudioModeAsync: (o: { allowsRecording: boolean }) => {
    calls.push(`audio ${o.allowsRecording}`);
    return o.allowsRecording ? audioMode() : Promise.resolve();
  },
};
mock.module('./optionalNative', () => ({ optionalNative: () => audio }));
let callPhase = 'idle';
let recorderPhase = 'idle';
mock.module('./calls/callManager', () => ({ getCallSnapshot: () => ({ phase: callPhase }) }));
mock.module('./recorder', () => ({ getRecorderSnapshot: () => ({ phase: recorderPhase }) }));
let capture: (opts: { signal?: { aborted: boolean } }) => Promise<unknown> = async () => null;
mock.module('./asrCapture', () => ({
  micTapSupported: () => true,
  startAsrCapture: (opts: { signal?: { aborted: boolean } }) => {
    calls.push('tap');
    return capture(opts);
  },
}));

const { phoneDictationHost, DICTATION_ABANDONED, DICTATION_CALL_BUSY, DICTATION_RECORDING_BUSY, DICTATION_MIC_UNAVAILABLE } = await import('./dictationHost');
const events = { onPartial() {}, onUtterance() {}, onFailed() {}, onDropped() {} };
const open = (signal: { aborted: boolean }) =>
  phoneDictationHost({} as never, ['en']).open(events, signal).catch((e: Error) => e);
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  calls.length = 0;
  permission = async () => ({ granted: true });
  audioMode = async () => {};
  capture = async () => null;
  callPhase = 'idle';
  recorderPhase = 'idle';
});

test('a huddle, a recording or a refused tap each say why in a line that fits the one-line notice bar', async () => {
  callPhase = 'connected';
  const huddle = ((await open({ aborted: false })) as Error).message;
  callPhase = 'idle';
  recorderPhase = 'recording';
  const recording = ((await open({ aborted: false })) as Error).message;
  recorderPhase = 'idle';
  // Permission granted, but the OS gave no tap this time.
  const unavailable = ((await open({ aborted: false })) as Error).message;
  expect([huddle, recording, unavailable]).toEqual([DICTATION_CALL_BUSY, DICTATION_RECORDING_BUSY, DICTATION_MIC_UNAVAILABLE]);
  expect([huddle, recording, unavailable]).toEqual(['A huddle is using the mic', 'A recording is using the mic', 'Mic unavailable. Try again.']);
  for (const line of [huddle, recording, unavailable]) expect(line.length).toBeLessThan(40);
});

test('cancelled during the permission prompt: no audio session, no tap', async () => {
  const prompt = deferred<{ granted: boolean }>();
  permission = () => prompt.promise;
  const signal = { aborted: false };
  const opening = open(signal);
  signal.aborted = true;
  prompt.resolve({ granted: true });
  expect(((await opening) as Error).message).toBe(DICTATION_ABANDONED);
  expect(calls).toEqual([]);
});

test('cancelled while the audio session flips: it flips back and no tap opens', async () => {
  const flip = deferred<void>();
  audioMode = () => flip.promise;
  const signal = { aborted: false };
  const opening = open(signal);
  await new Promise((r) => setTimeout(r, 0));
  signal.aborted = true;
  flip.resolve();
  expect(((await opening) as Error).message).toBe(DICTATION_ABANDONED);
  expect(calls).toEqual(['audio true', 'audio false']);
});

test('cancelled while the tap opens: the capture hears it and is closed', async () => {
  const tap = deferred<unknown>();
  let seen: { aborted: boolean } | undefined;
  let closed = 0;
  capture = (opts) => {
    seen = opts.signal;
    return tap.promise;
  };
  const signal = { aborted: false };
  const opening = open(signal);
  await new Promise((r) => setTimeout(r, 0));
  signal.aborted = true;
  tap.resolve({ finish: async () => {}, close: () => closed++ });
  expect(((await opening) as Error).message).toBe(DICTATION_ABANDONED);
  expect(seen).toBe(signal);
  expect(closed).toBe(1);
  expect(calls).toEqual(['audio true', 'tap', 'audio false']);
});

test('a start nobody abandons opens as before', async () => {
  capture = async () => ({ finish: async () => {}, close: () => {} });
  const pipe = await open({ aborted: false });
  expect(pipe).not.toBeInstanceOf(Error);
  expect(calls).toEqual(['audio true', 'tap']);
});
