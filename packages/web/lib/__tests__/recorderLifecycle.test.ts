// The recorder, end to end, with a fake browser.
//
// What the tests here defend is the ORDER and the FAILURE MODES, because those
// are what a person actually loses when they get one wrong: a microphone left
// open after stop, a transcript row created for a recording that never began,
// or a transcript thrown away because an upload failed on a bad connection.
// The words are the artifact — everything else in this feature is allowed to
// fail without costing them.
//
// Real recorder.ts, real scribeEngine.ts, real asrPipe.ts: the seams between
// them are the whole point, so mocking any of the three would test nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { parseRoomKey } from "@codecast/shared/contracts";
import {
  bindRecorder,
  getRecorderStatus,
  startRecording,
  stopRecording,
} from "../calls/recorder";

// ── the fake browser ───────────────────────────────────────────────────────

class FakeTrack {
  readyState = "live";
  /** The last applyConstraints payload — how a test sees the echo-cancellation
   *  flip when the loopback feed lands. */
  constraints: Record<string, unknown> | null = null;
  onended: (() => void) | null = null;
  constructor(public kind: string = "audio") {}
  applyConstraints(c: Record<string, unknown>) {
    this.constraints = c;
    return Promise.resolve();
  }
  stop() {
    this.readyState = "ended";
  }
}

class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  sampleRate = 24_000;
  closed = false;
  constructor() {
    FakeAudioContext.made.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    return { onaudioprocess: null, connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return {
      fftSize: 256,
      smoothingTimeConstant: 0.6,
      getByteTimeDomainData() {},
      connect() {},
      disconnect() {},
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createMediaStreamDestination() {
    return { stream: new (globalThis as any).MediaStream([]) };
  }
  get destination() {
    return {};
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  static open() {
    return FakeAudioContext.made.filter((c) => !c.closed).length;
  }
}

class FakeMediaRecorder {
  static made: FakeMediaRecorder[] = [];
  static isTypeSupported(mime: string) {
    return mime === "audio/webm;codecs=opus";
  }
  state = "inactive";
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, _opts?: unknown) {
    FakeMediaRecorder.made.push(this);
  }
  start(_ms?: number) {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

let micTracks: FakeTrack[] = [];
/** What getUserMedia does when the recorder asks. */
let micGrants = true;
/** The desktop loopback feed: what getDisplayMedia does when the recorder
 *  asks for the computer's audio. */
let displayGrants = true;
let sysTracks: Array<{ video: FakeTrack; audio: FakeTrack }> = [];
/** When set, getDisplayMedia waits on it — a permission prompt somebody
 *  answers after the recording is already over. */
let displayGate: Promise<void> | null = null;

// Bun runs every test file in ONE process, so a global this file replaces is a
// global the next file inherits. Restoring by assignment is not enough: a key
// that did not exist here (MediaRecorder) would come back as `undefined`
// rather than absent, and `navigator` set to undefined takes react-dom's
// renderer down in whatever file runs next. Descriptors in, descriptors out.
const originals = new Map<string, PropertyDescriptor | null>();
const ORIGINAL_KEYS = [
  "AudioContext",
  "MediaStream",
  "MediaRecorder",
  "navigator",
  "fetch",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "window",
];

// ── the fake convex client ─────────────────────────────────────────────────

let mutations: Array<{ name: string; args: any }> = [];
/** Whether the storage upload succeeds — a bad connection is the case that
 *  must not cost anyone a transcript. */
let uploadWorks = true;

const convex = {
  action: async () => ({ error: "no ASR in tests" }),
  mutation: async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    mutations.push({ name, args });
    if (name === "transcripts:start") return { transcript_id: "t-rec-1", existing: false };
    if (name === "images:generateUploadUrl") return "https://storage.test/upload";
    return null;
  },
};

const called = (name: string) => mutations.filter((m) => m.name === name);

beforeEach(() => {
  mutations = [];
  micTracks = [];
  micGrants = true;
  displayGrants = true;
  sysTracks = [];
  displayGate = null;
  uploadWorks = true;
  FakeAudioContext.made = [];
  FakeMediaRecorder.made = [];
  for (const key of ORIGINAL_KEYS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null);
  }
  const install = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  install("AudioContext", FakeAudioContext);
  install("MediaRecorder", FakeMediaRecorder);
  (globalThis as any).MediaStream = class {
    constructor(public tracks: Array<{ kind?: string }> = []) {}
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t?.kind !== "video");
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t?.kind === "video");
    }
  };
  install("MediaStream", (globalThis as any).MediaStream);
  install("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        if (!micGrants) throw new Error("NotAllowedError");
        const track = new FakeTrack();
        micTracks.push(track);
        return new (globalThis as any).MediaStream([track]);
      },
      getDisplayMedia: async () => {
        if (displayGate) await displayGate;
        if (!displayGrants) throw new Error("NotAllowedError");
        const video = new FakeTrack("video");
        const audio = new FakeTrack("audio");
        sysTracks.push({ video, audio });
        return new (globalThis as any).MediaStream([video, audio]);
      },
    },
  });
  install("fetch", async () =>
    uploadWorks
      ? { ok: true, json: async () => ({ storageId: "st-1" }) }
      : { ok: false, json: async () => ({}) },
  );
  // The meter's pump: run nothing, so a test never depends on frames.
  install("requestAnimationFrame", () => 0);
  install("cancelAnimationFrame", () => {});
  bindRecorder(convex as any);
});

afterEach(async () => {
  // A microphone left open between tests is this feature's worst failure, and
  // it would also make the next test's arithmetic lie.
  await stopRecording().catch(() => {});
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
  originals.clear();
});

describe("the recorder", () => {
  test("a press opens a transcript on a fresh rec key and one microphone", async () => {
    const id = await startRecording();
    expect(id).toBe("t-rec-1");

    const start = called("transcripts:start");
    expect(start).toHaveLength(1);
    const parsed = parseRoomKey(start[0].args.room_key);
    // The key it mints is a recording's, and the server's rec rules are what
    // that buys: owner only, no room, no team feature.
    expect(parsed?.kind).toBe("rec");

    const status = getRecorderStatus();
    expect(status.phase).toBe("recording");
    expect(status.transcriptId).toBe("t-rec-1");
    expect(status.startedAt).toBeGreaterThan(0);
    // Exactly one microphone, and it is open.
    expect(micTracks).toHaveLength(1);
    expect(micTracks[0].readyState).toBe("live");
    expect(FakeMediaRecorder.made).toHaveLength(1);
    expect(FakeMediaRecorder.made[0].state).toBe("recording");
    // Three audio contexts, all opened synchronously by the press: the
    // recognizer's capture, the meter's analyser, and the audio file's mix.
    // If capture ever moved behind a round trip again, everything said in
    // that gap would be lost.
    expect(FakeAudioContext.made.length).toBe(3);
  });

  test("every recording gets its own id", async () => {
    await startRecording();
    await stopRecording();
    await startRecording();
    const keys = called("transcripts:start").map((m) => m.args.room_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a second press while recording starts nothing new", async () => {
    const first = await startRecording();
    const second = await startRecording();
    expect(second).toBe(first);
    expect(called("transcripts:start")).toHaveLength(1);
  });

  test("stop ends the transcript, then attaches the audio, and lets go of everything", async () => {
    await startRecording();
    await stopRecording();

    // The transcript ends first — that is what schedules the summary — and the
    // audio is attached afterwards, so a slow or failing upload can never sit
    // in front of somebody's words.
    const order = mutations.map((m) => m.name);
    expect(order.indexOf("transcripts:stop")).toBeGreaterThan(-1);
    expect(order.indexOf("transcripts:attachRecording")).toBeGreaterThan(
      order.indexOf("transcripts:stop"),
    );
    expect(called("transcripts:attachRecording")[0].args).toEqual({
      transcript_id: "t-rec-1",
      storage_id: "st-1",
    });

    // Nothing is still listening: the microphone is stopped and every audio
    // context the run opened (recognizer and meter) is closed.
    expect(micTracks[0].readyState).toBe("ended");
    expect(FakeAudioContext.open()).toBe(0);
    expect(getRecorderStatus().phase).toBe("idle");
    expect(getRecorderStatus().transcriptId).toBeNull();
  });

  test("a failed upload costs the audio and nothing else", async () => {
    uploadWorks = false;
    await startRecording();
    await stopRecording();
    expect(called("transcripts:stop")).toHaveLength(1);
    expect(called("transcripts:attachRecording")).toHaveLength(0);
    expect(getRecorderStatus().phase).toBe("idle");
  });

  test("a refused microphone leaves no transcript behind", async () => {
    micGrants = false;
    const id = await startRecording();
    expect(id).toBeNull();
    // The row is what a person would later find in their history: a recording
    // that never happened must not be one of them.
    expect(called("transcripts:start")).toHaveLength(0);
    const status = getRecorderStatus();
    expect(status.phase).toBe("idle");
    expect(status.error).toContain("microphone");
  });

  test("a browser recording never asks for the computer's audio", async () => {
    // No desktop shell, no loopback: getDisplayMedia stays untouched and the
    // status says the honest thing.
    await startRecording();
    await Bun.sleep(1);
    expect(sysTracks).toHaveLength(0);
    expect(getRecorderStatus().systemAudio).toBe(false);
  });

  test("a recording holds its own lease while it runs", async () => {
    // There is no room and no seat to keep it alive, so the beat is the only
    // thing standing between a live recording and the orphan sweep.
    await startRecording();
    await Bun.sleep(0);
    // The beat rides a timer; what matters here is that stopping cancels it,
    // so a stopped recording never touches an ended transcript.
    await stopRecording();
    const beatsAfterStop = called("transcripts:beat").length;
    await Bun.sleep(20);
    expect(called("transcripts:beat").length).toBe(beatsAfterStop);
  });
});

describe("system audio (desktop loopback)", () => {
  // The recorder recognizes the desktop by the shell's bridge object; the
  // descriptor dance in beforeEach restores `window` to absent afterwards.
  const onDesktop = () =>
    Object.defineProperty(globalThis, "window", {
      value: { __CODECAST_ELECTRON__: {} },
      configurable: true,
      writable: true,
    });

  test("the computer's audio joins the recording, and stop lets go of it", async () => {
    onDesktop();
    await startRecording();
    await Bun.sleep(1);

    expect(getRecorderStatus().systemAudio).toBe(true);
    expect(sysTracks).toHaveLength(1);
    // The video track is the toll of the getDisplayMedia API — put down on
    // arrival, while the audio feed stays live.
    expect(sysTracks[0].video.readyState).toBe("ended");
    expect(sysTracks[0].audio.readyState).toBe("live");
    // With a direct feed in hand, the microphone narrows to the person:
    // echo cancellation flips on so speakers are not transcribed twice.
    expect(micTracks[0].constraints?.echoCancellation).toBe(true);

    await stopRecording();
    expect(sysTracks[0].audio.readyState).toBe("ended");
    expect(getRecorderStatus().systemAudio).toBe(false);
    expect(FakeAudioContext.open()).toBe(0);
  });

  test("a refused loopback leaves the recording exactly what it was", async () => {
    onDesktop();
    displayGrants = false;
    await startRecording();
    await Bun.sleep(1);
    expect(getRecorderStatus().phase).toBe("recording");
    expect(getRecorderStatus().systemAudio).toBe(false);
    await stopRecording();
    expect(called("transcripts:stop")).toHaveLength(1);
  });

  test("a loopback that lands after stop is put down, not attached", async () => {
    onDesktop();
    // The screen-permission prompt is answered after the recording is over.
    let openGate!: () => void;
    displayGate = new Promise((r) => (openGate = r));
    await startRecording();
    await stopRecording();
    openGate();
    await Bun.sleep(1);
    expect(sysTracks).toHaveLength(1);
    expect(sysTracks[0].audio.readyState).toBe("ended");
    expect(getRecorderStatus().systemAudio).toBe(false);
  });
});
