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

import {
  __resetAsrCaptureForTest,
  floatTo16,
  openAsrPipe,
  openAsrPcmSession,
} from "../calls/asrPipe";

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
  __resetAsrCaptureForTest();
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
  __resetAsrCaptureForTest();
  for (const [name, value] of Object.entries(originals)) (globalThis as any)[name] = value;
});

const TRACK = { readyState: "live" } as unknown as MediaStreamTrack;

/** A buffer of `n` samples at the pipe's own rate, so one buffer in is one
 *  append out of the same size — the test can then read the ORDER off sizes. */
const frame = (n: number): Frame => new Float32Array(n).fill(0.5);

function open(
  events?: Parameters<typeof openAsrPipe>[0]["events"],
  languages: string[] = ["en"],
) {
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
    languages,
  });
  return {
    pipe,
    /** Let the mint answer and the socket be constructed. */
    async connect(secret: string | null = "sk-test", extra: Record<string, unknown> = {}) {
      settleMint(secret ? { client_secret: secret, ...extra } : { error: "refused" });
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

  test("a socket the browser refuses to construct fails the pipe instead of throwing (ct-73198)", async () => {
    (globalThis as any).WebSocket = class {
      constructor() {
        throw new SyntaxError("Failed to construct 'WebSocket': the provided URL is invalid.");
      }
    };
    const failed: string[] = [];
    const h = open({ onFailed: (m) => failed.push(m) });
    await h.connect();
    expect(failed).toEqual(["Could not start transcription"]);
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

  test("a line in a script the allowlist did not name is not shown", async () => {
    const partials: string[] = [];
    const heard: string[] = [];
    const h = open({ onPartial: (t) => partials.push(t), onUtterance: (u) => heard.push(u.text) });
    const ws = await h.connect();
    ws.open();

    ws.deliver({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "위위위",
    });
    expect(partials.at(-1)).toBe("");

    ws.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "アショット, サムビット, エージェントレイヤー。",
    });
    expect(heard).toEqual([]);
  });

  test("Japanese is kept when Japanese is on the allowlist", async () => {
    const heard: string[] = [];
    const h = open({ onUtterance: (u) => heard.push(u.text) }, ["ja", "en"]);
    const ws = await h.connect();
    ws.open();
    ws.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "アショット, サムビット, エージェントレイヤー。",
    });
    expect(heard).toEqual(["アショット, サムビット, エージェントレイヤー。"]);
  });

  test("the minted session is left alone; audio flushes without a session.update", async () => {
    const h = open(undefined, ["en", "ja"]);
    const ws = await h.connect();
    h.audio().speak(frame(100));
    ws.open();
    // Rewriting the session on open was how a huddle lost every word: it
    // swapped the live model onto a socket whose VAD had already been set,
    // and the live model then waited for a commit nobody sent.
    expect(ws.types()).not.toContain("session.update");
    expect(ws.appends()).toEqual([100]);
  });

  test("an empty mint list does not wipe the device list", async () => {
    const heard: string[] = [];
    const h = open({ onUtterance: (u) => heard.push(u.text) }, ["en"]);
    const ws = await h.connect("sk-test", { languages: [] });
    ws.open();
    ws.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "위위위",
    });
    expect(heard).toEqual([]);
  });

  test("the mint's room union is what the pipe filters against", async () => {
    const heard: string[] = [];
    const h = open({ onUtterance: (u) => heard.push(u.text) }, ["en"]);
    const ws = await h.connect("sk-test", { languages: ["en", "ja"] });
    ws.open();
    ws.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "アショット, サムビット, エージェントレイヤー。",
    });
    expect(heard).toEqual(["アショット, サムビット, エージェントレイヤー。"]);
  });
});

describe("asrPipe: the endpointer closes turns and stamps them", () => {
  // 24 kHz in the fake context: 2400 samples is 100 ms.
  const loud = (ms: number) => frame((ms / 1000) * 24_000);
  const quiet = (ms: number) => new Float32Array((ms / 1000) * 24_000);

  function openAt(clockMs: number, events: Parameters<typeof openAsrPipe>[0]["events"]) {
    let settle: (v: any) => void = () => {};
    const minted = new Promise((r) => (settle = r));
    const pipe = openAsrPipe({
      convex: { action: () => minted as any },
      roomKey: "dm:a:b",
      track: TRACK,
      clock: () => clockMs,
      events,
      languages: ["en"],
    });
    return {
      pipe,
      async connect(extra: Record<string, unknown> = { model: "gpt-live-transcribe" }) {
        settle({ client_secret: "sk-test", ...extra });
        await Promise.resolve();
        await Promise.resolve();
        return FakeWebSocket.live[0]!;
      },
      audio: () => FakeAudioContext.live[0]!,
    };
  }

  test("a pause after speech commits, fires start/stop, and the line carries when it was said", async () => {
    const log: string[] = [];
    const lines: Array<{ text: string; t0: number; t1: number }> = [];
    const h = openAt(5_000, {
      onSpeechStart: () => log.push("start"),
      onSpeechStop: () => log.push("stop"),
      onUtterance: (u) => lines.push(u),
    });
    const ws = await h.connect();
    ws.open();
    h.audio().speak(quiet(1_000));
    h.audio().speak(loud(400));
    expect(h.pipe.speaking).toBe(true);
    h.audio().speak(quiet(700));
    expect(log).toEqual(["start", "stop"]);
    expect(h.pipe.speaking).toBe(false);
    expect(ws.types().filter((t) => t === "input_audio_buffer.commit")).toHaveLength(1);
    ws.deliver({ type: "input_audio_buffer.committed", item_id: "i1" });
    ws.deliver({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "hello there" });
    expect(lines).toEqual([{ text: "hello there", t0: 6_000, t1: 6_400 }]);
    h.pipe.close();
  });

  test("a turn that closes before the socket opens commits in order, at the sample it closed", async () => {
    const h = openAt(0, {});
    h.audio().speak(quiet(200));
    h.audio().speak(loud(400));
    h.audio().speak(quiet(700));
    const ws = await h.connect();
    ws.open();
    // The turn closed 600 ms after the voice stopped (at 1.2 s): the commit
    // sits exactly there, and the 100 ms after it follows.
    const sent = ws.sent.map((m) => JSON.parse(m));
    const at = sent.findIndex((m) => m.type === "input_audio_buffer.commit");
    const samples = (ms: typeof sent) => ms.reduce((a, m) => a + atob(m.audio).length / 2, 0);
    expect(sent.filter((m) => m.type === "input_audio_buffer.commit")).toHaveLength(1);
    expect(samples(sent.slice(0, at))).toBe(28_800);
    expect(samples(sent.slice(at + 1))).toBe(2_400);
    h.pipe.close();
  });

  const commits = (ws: FakeWebSocket) => ws.types().filter((t) => t === "input_audio_buffer.commit").length;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  test("finish waits for its own commit, not for the answer to an earlier turn", async () => {
    const heard: string[] = [];
    const h = openAt(0, { onUtterance: (u) => heard.push(u.text) });
    const ws = await h.connect();
    ws.open();
    h.audio().speak(quiet(200));
    h.audio().speak(loud(400));
    h.audio().speak(quiet(700));
    h.audio().speak(loud(500));
    let done = false;
    const finishing = h.pipe.finish().then(() => (done = true));
    await settle();
    expect(commits(ws)).toBe(2);
    ws.deliver({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "first" });
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false);
    ws.deliver({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "last words" });
    await finishing;
    expect(heard).toEqual(["first", "last words"]);
  });

  test("finish sends no empty commit when the last turn already committed everything", async () => {
    const h = openAt(0, {});
    const ws = await h.connect();
    ws.open();
    h.audio().speak(quiet(200));
    h.audio().speak(loud(400));
    // The turn closes exactly at the end of this buffer: nothing follows it.
    h.audio().speak(quiet(600));
    expect(commits(ws)).toBe(1);
    const finishing = h.pipe.finish();
    await settle();
    expect(commits(ws)).toBe(1);
    ws.deliver({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "done" });
    await finishing;
    expect(ws.closedByClient).toBe(true);
  });

  test("an older mint naming another model closes turns on server VAD: no client commit", async () => {
    const h = openAt(0, {});
    const ws = await h.connect({});
    ws.open();
    h.audio().speak(loud(400));
    h.audio().speak(quiet(700));
    expect(ws.types()).not.toContain("input_audio_buffer.commit");
    h.pipe.close();
  });
});

describe("asrPipe: a language mint that OpenAI refuses still transcribes", () => {
  test("the second mint is unconstrained, and the pipe opens", async () => {
    const calls: Array<{ room_key: string; languages?: string[] }> = [];
    let n = 0;
    const pipe = openAsrPipe({
      convex: {
        action: async (_fn: unknown, args: { room_key: string; languages?: string[] }) => {
          calls.push(args);
          n += 1;
          if (n === 1) return { error: "ASR session mint failed (400)" };
          return { client_secret: "sk-test", model: "gpt-live-transcribe", languages: [] };
        },
      } as any,
      roomKey: "dm:a:b",
      track: TRACK,
      clock: () => 0,
      languages: ["en", "zz"],
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(calls).toEqual([
      { room_key: "dm:a:b", languages: ["en"], client_turns: true },
      { room_key: "dm:a:b", client_turns: true },
    ]);
    expect(FakeWebSocket.live.length).toBe(1);
    pipe.close();
  });
});

describe("asrPipe: a server from before client_turns", () => {
  test("an argument refusal is retried once without client_turns, and the pipe follows the model it gets", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pipe = openAsrPipe({
      convex: {
        action: async (_fn: unknown, args: Record<string, unknown>) => {
          calls.push(args);
          if ("client_turns" in args) {
            throw new Error("ArgumentValidationError: Object contains extra field `client_turns` that is not in the validator.");
          }
          return { client_secret: "sk-test", model: "gpt-4o-mini-transcribe", languages: [] };
        },
      } as any,
      roomKey: "dm:a:b",
      track: TRACK,
      clock: () => 0,
      languages: ["en"],
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(calls).toEqual([
      { room_key: "dm:a:b", languages: ["en"], client_turns: true },
      { room_key: "dm:a:b", languages: ["en"] },
    ]);
    const ws = FakeWebSocket.live[0]!;
    ws.open();
    const ac = FakeAudioContext.live[0]!;
    ac.speak(new Float32Array(4_800));
    ac.speak(new Float32Array(9_600).fill(0.5));
    ac.speak(new Float32Array(16_800));
    // Server VAD closes the legacy model's turns: the pipe must not commit too.
    expect(ws.types()).not.toContain("input_audio_buffer.commit");
    pipe.close();
  });
});

describe("asrPipe: a first mint that throws", () => {
  async function mintCalls(first: () => Promise<any>) {
    const calls: Array<Record<string, unknown>> = [];
    const pipe = openAsrPipe({
      convex: {
        action: async (_fn: unknown, args: Record<string, unknown>) => {
          calls.push(args);
          if (calls.length === 1) return first();
          return { client_secret: "sk-test", model: "gpt-live-transcribe", languages: ["en"] };
        },
      } as any,
      roomKey: "dm:a:b",
      track: TRACK,
      clock: () => 0,
      languages: ["en"],
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    pipe.close();
    return calls;
  }

  test("a redacted Server Error is retried once without client_turns", async () => {
    const calls = await mintCalls(() => Promise.reject(new Error("[Request ID: abc] Server Error")));
    expect(calls).toEqual([
      { room_key: "dm:a:b", languages: ["en"], client_turns: true },
      { room_key: "dm:a:b", languages: ["en"] },
    ]);
    expect(FakeWebSocket.live.length).toBe(1);
  });

  test("a network failure is retried the same way", async () => {
    const calls = await mintCalls(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ room_key: "dm:a:b", languages: ["en"] });
  });

  test("a returned error is the server's answer and is not retried without client_turns", async () => {
    const calls = await mintCalls(async () => ({ error: "Not authorized for this room" }));
    expect(calls).toEqual([{ room_key: "dm:a:b", languages: ["en"], client_turns: true }]);
    expect(FakeWebSocket.live.length).toBe(0);
  });
});

describe("asrPcmSession: a caller that already has samples", () => {
  test("int16 at 48 kHz is resampled to 24 kHz before it hits the socket", async () => {
    let settleMint: (v: any) => void = () => {};
    const minted = new Promise((resolve) => {
      settleMint = resolve;
    });
    const session = openAsrPcmSession({
      convex: { action: () => minted as any },
      roomKey: "rec:abc",
      clock: () => 0,
    });
    // 10 ms at 48 kHz is 480 samples; at 24 kHz that is 240.
    session.feedInt16(new Int16Array(480).fill(1000), 48_000);
    settleMint({ client_secret: "sk-test" });
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.live[0]!;
    ws.open();
    expect(ws.appends()).toEqual([240]);
    session.close();
  });

  test("floatTo16 box-averages 48 kHz -> 24 kHz instead of aliasing Nyquist noise into speech", () => {
    // Alternating +1/-1 at 48 kHz is 24 kHz Nyquist hiss. Point-sampling read
    // every even index (+1 -> +32767 full-scale buzz); box-averaging cancels pairs.
    const nyquist = new Float32Array(480);
    for (let i = 0; i < nyquist.length; i++) nyquist[i] = i % 2 === 0 ? 1 : -1;
    const out = new Int16Array(floatTo16(nyquist, 48_000));
    expect(out.length).toBe(240);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe("asrPipe: shared AudioContext and off-main-thread AudioWorklet", () => {
  test("four concurrent huddle tracks share one AudioContext and close it when the last leaves", () => {
    const never = () => new Promise(() => {}) as any;
    const pipes = [1, 2, 3, 4].map(() =>
      openAsrPipe({ convex: { action: never }, roomKey: "dm:a:b", track: TRACK, clock: () => 0 }),
    );
    expect(FakeAudioContext.live.length).toBe(1);
    expect(FakeAudioContext.live[0]!.closed).toBe(false);

    pipes[0]!.close();
    pipes[1]!.close();
    pipes[2]!.close();
    expect(FakeAudioContext.live[0]!.closed).toBe(false);

    pipes[3]!.close();
    expect(FakeAudioContext.live[0]!.closed).toBe(true);
  });

  test("upgrades capture from bootstrap ScriptProcessor to AudioWorkletNode once the module loads", async () => {
    let scriptDisconnected = false;
    const workletNodes: Array<{ port: { onmessage: ((e: any) => void) | null }; disconnected: boolean }> = [];
    class WorkletAudioContext extends FakeAudioContext {
      audioWorklet = {
        addModule: async () => {},
      };
      override createScriptProcessor() {
        const proc = super.createScriptProcessor();
        return {
          ...proc,
          disconnect() {
            scriptDisconnected = true;
          },
        };
      }
    }
    class FakeAudioWorkletNode {
      port = { onmessage: null as ((e: any) => void) | null };
      disconnected = false;
      constructor() {
        workletNodes.push(this);
      }
      connect() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    const prevWorklet = (globalThis as any).AudioWorkletNode;
    (globalThis as any).AudioContext = WorkletAudioContext;
    (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
    try {
      const h = open();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(workletNodes.length).toBe(1);
      expect(scriptDisconnected).toBe(true);

      workletNodes[0]!.port.onmessage?.({ data: frame(160) });
      const ws = await h.connect();
      ws.open();
      expect(ws.appends()).toEqual([160]);
      h.pipe.close();
      expect(workletNodes[0]!.disconnected).toBe(true);
    } finally {
      (globalThis as any).AudioWorkletNode = prevWorklet;
    }
  });
});
