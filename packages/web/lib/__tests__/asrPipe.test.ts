// The recognizer's two ends, which is where every "no words" burst was lost.
//
// A walkie burst is two or three seconds long. The pipe used to open its
// microphone inside the websocket's `onopen`, so a mint round trip and a TLS
// handshake sat in front of the audio and most of a short burst was spoken
// before anything was listening. And it closed the socket the moment the key
// came up, so the utterance the server's VAD had not closed yet — on a short
// burst, the only one — was thrown away. Both ends now hold, and these are the
// tests that say so.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openAsrPipe } from "../calls/asrPipe";

// ── the browser, in as much as this file touches it ────────────────────────

type Frame = Float32Array;

/** An AudioContext that never makes a sound: the test drives the processor by
 *  hand, so "the microphone produced a buffer" is one call rather than a wait. */
class FakeAudioContext {
  static live: FakeAudioContext[] = [];
  sampleRate = 24_000;
  closed = false;
  private processors: Array<{ onaudioprocess: ((e: any) => void) | null }> = [];
  constructor() {
    FakeAudioContext.live.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    const proc = { onaudioprocess: null as ((e: any) => void) | null, connect() {}, disconnect() {} };
    this.processors.push(proc);
    return proc;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  get destination() {
    return {};
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  /** One buffer off the microphone. */
  speak(frame: Frame) {
    for (const proc of this.processors) {
      proc.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
    }
  }
}

class FakeWebSocket {
  static live: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeWebSocket.live.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Every append this socket received, decoded back to sample counts. */
  appends(): number[] {
    return this.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === "input_audio_buffer.append")
      .map((m) => atob(m.audio).length / 2);
  }
  types(): string[] {
    return this.sent.map((s) => JSON.parse(s).type);
  }
}

const originals: Record<string, any> = {};

beforeEach(() => {
  FakeWebSocket.live = [];
  FakeAudioContext.live = [];
  for (const name of ["WebSocket", "AudioContext", "MediaStream"]) {
    originals[name] = (globalThis as any)[name];
  }
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).MediaStream = class {
    constructor(public tracks: unknown[]) {}
  };
});

afterEach(() => {
  for (const [name, value] of Object.entries(originals)) (globalThis as any)[name] = value;
});

const TRACK = { readyState: "live" } as unknown as MediaStreamTrack;

/** A buffer of `n` samples at the pipe's own rate, so one buffer in is one
 *  append out of the same size — the test can then read the ORDER off sizes. */
const frame = (n: number): Frame => new Float32Array(n).fill(0.5);

function open(events?: Parameters<typeof openAsrPipe>[0]["events"]) {
  let settleMint: (v: any) => void = () => {};
  const minted = new Promise((resolve) => {
    settleMint = resolve;
  });
  const pipe = openAsrPipe({
    convex: { action: () => minted as any },
    roomKey: "dm:a:b",
    track: TRACK,
    clock: () => 0,
    events,
  });
  return {
    pipe,
    /** Let the mint answer and the socket be constructed. */
    async connect(secret: string | null = "sk-test") {
      settleMint(secret ? { client_secret: secret } : { error: "refused" });
      await Promise.resolve();
      await Promise.resolve();
      return FakeWebSocket.live[0];
    },
    audio: () => FakeAudioContext.live[0],
  };
}

describe("asrPipe: nothing spoken before the socket is lost", () => {
  test("the microphone is open before the mint has even answered", () => {
    open();
    // Not "after the token", not "after onopen" — synchronously, in the same
    // turn as the press.
    expect(FakeAudioContext.live.length).toBe(1);
  });

  test("audio buffered before connect is flushed, in the order it was said", async () => {
    const h = open();
    // Three distinct buffers while the socket is still a promise.
    h.audio().speak(frame(100));
    h.audio().speak(frame(200));
    h.audio().speak(frame(300));
    const ws = await h.connect();
    expect(ws.appends()).toEqual([]);

    ws.open();
    expect(ws.appends()).toEqual([100, 200, 300]);

    // And from here it streams straight through rather than buffering again.
    h.audio().speak(frame(400));
    expect(ws.appends()).toEqual([100, 200, 300, 400]);
  });

  test("a mint that was refused says so, and never leaves a silent pipe pretending", async () => {
    const failed: string[] = [];
    const h = open({ onFailed: (m) => failed.push(m) });
    h.audio().speak(frame(100));
    await h.connect(null);
    expect(failed).toEqual(["refused"]);
    // The burst is not over — the caller records and transcribes it elsewhere —
    // but this pipe has nothing more to offer, so a release must not wait on it.
    const t0 = Date.now();
    await h.pipe.finish();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

// A dead pipe gives its microphone back BY ITSELF.
//
// This was free while capture began in the websocket's `onopen`: a pipe that
// never connected had allocated nothing, so a caller that dropped it lost
// nothing. Capture now starts at open(), so the same pipe holds an AudioContext
// and a ScriptProcessor deliberately wired to the destination to keep the
// processor running — and the scribe's failure path drops pipes without closing
// them. Making failure self-cleaning is what stops that from being a leak, in
// the scribe and in any caller written later.
describe("asrPipe: a pipe that cannot work lets go", () => {
  test("a refused mint closes its own capture before it reports the failure", async () => {
    let openAtFailure: boolean | undefined;
    const h = open({ onFailed: () => (openAtFailure = h.audio().closed) });
    h.audio().speak(frame(100));
    await h.connect(null);
    // Already closed when the caller hears about it, so `onFailed` means
    // "finished", never "now your chore".
    expect(openAtFailure).toBe(true);
    expect(h.audio().closed).toBe(true);
  });

  test("a socket that drops closes its capture too — the caller opens a fresh pipe, not this one", async () => {
    let openAtDrop: boolean | undefined;
    const h = open({ onDropped: () => (openAtDrop = h.audio().closed) });
    const ws = await h.connect();
    ws.open();
    h.audio().speak(frame(100));

    ws.readyState = 3;
    ws.onclose?.();
    expect(openAtDrop).toBe(true);
    expect(h.audio().closed).toBe(true);
  });

  test("a pipe the caller closes anyway is unharmed by the double close", async () => {
    const h = open();
    await h.connect(null);
    h.pipe.close();
    await h.pipe.finish();
    expect(h.audio().closed).toBe(true);
  });
});

describe("asrPipe: the last sentence", () => {
  test("finish flushes, commits, and waits for the words before closing", async () => {
    const heard: string[] = [];
    const h = open({ onUtterance: (u) => heard.push(u.text) });
    const ws = await h.connect();
    ws.open();
    h.audio().speak(frame(100));

    let done = false;
    const finishing = h.pipe.finish().then(() => {
      done = true;
    });
    // The commit goes at once; the close does NOT, because the words the commit
    // asked for have not come back yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.types()).toContain("input_audio_buffer.commit");
    expect(done).toBe(false);
    expect(ws.closedByClient).toBe(false);

    ws.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "back in five",
    });
    await finishing;
    expect(heard).toEqual(["back in five"]);
    expect(ws.closedByClient).toBe(true);
  });

  test("audio captured after the key came up is never appended past the commit", async () => {
    const h = open();
    const ws = await h.connect();
    ws.open();
    h.audio().speak(frame(100));
    const finishing = h.pipe.finish();
    // A processor callback that was already in flight when the hand came off.
    h.audio().speak(frame(999));
    ws.deliver({ type: "conversation.item.input_audio_transcription.completed", transcript: "hi" });
    await finishing;
    expect(ws.appends()).toEqual([100]);
  });

  test("a recognizer that goes quiet does not hold the released key forever", async () => {
    const h = open();
    const ws = await h.connect();
    ws.open();
    h.audio().speak(frame(100));
    const t0 = Date.now();
    await h.pipe.finish();
    // Bounded at 2.5s, so the message lands either way.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_400);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(ws.closedByClient).toBe(true);
  }, 10_000);

  test("finish is idempotent and close after it is harmless", async () => {
    const h = open();
    const ws = await h.connect();
    ws.open();
    const a = h.pipe.finish();
    const b = h.pipe.finish();
    ws.deliver({ type: "conversation.item.input_audio_transcription.completed", transcript: "ok" });
    await Promise.all([a, b]);
    h.pipe.close();
    expect(ws.types().filter((t) => t === "input_audio_buffer.commit").length).toBe(1);
  });

  test("close is still the abandon path: nothing is committed and nothing waited for", async () => {
    const h = open();
    const ws = await h.connect();
    ws.open();
    h.audio().speak(frame(100));
    h.pipe.close();
    expect(ws.types()).not.toContain("input_audio_buffer.commit");
    expect(h.audio().closed).toBe(true);
  });
});

describe("asrPipe: words while they are still being said", () => {
  test("deltas rebuild the sentence in progress and the completed one replaces it", async () => {
    const partials: string[] = [];
    const heard: string[] = [];
    const h = open({ onPartial: (t) => partials.push(t), onUtterance: (u) => heard.push(u.text) });
    const ws = await h.connect();
    ws.open();

    const delta = (item: string, d: string) =>
      ws.deliver({ type: "conversation.item.input_audio_transcription.delta", item_id: item, delta: d });
    delta("item_1", "back");
    delta("item_1", " in");
    delta("item_1", " five");
    // Each one is the WHOLE sentence so far: the caller replaces, never appends.
    expect(partials).toEqual(["back", "back in", "back in five"]);

    ws.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "Back in five.",
    });
    // The sentence closed, so the trailing partial is cleared — otherwise the
    // caller would show it twice, once committed and once still hanging.
    expect(partials.at(-1)).toBe("");
    expect(heard).toEqual(["Back in five."]);

    // A second sentence starts from empty rather than from the first one's tail.
    delta("item_2", "actually");
    expect(partials.at(-1)).toBe("actually");
  });
});
