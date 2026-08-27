// The scribe must never lose track of a pipe it opened.
//
// A pipe holds a recognizer and — since capture starts when the pipe opens
// rather than when its websocket connects — an AudioContext and a
// ScriptProcessor, deliberately wired through to the destination so the
// processor keeps running. The scribe's failure path used to DELETE such a pipe
// from its map without closing it, which put those out of reach of everything:
// `stopScribe` only closes what the map still holds.
//
// That is not a slow leak. `attachRoomTracks` re-runs on every TrackSubscribed
// and every reconnect, so a huddle on a deployment where the mint keeps failing
// — no OPENAI_API_KEY, a rate limit, an authorizeRoom refusal — accumulates one
// live AudioContext per participant per re-attach for the length of the call.
// Browsers cap how many a page may have, so it eventually takes the walkie's
// meter and the call's mic level down with it.
//
// Real transcription.ts, real asrPipe.ts, fake browser: the point is the seam
// between them, so mocking either would test nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Track } from "livekit-client";
import { getScribeStatus, startScribe, stopScribe } from "../calls/transcription";

/** Counts what a leak would leave behind: contexts made, and contexts closed. */
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
  static open() {
    return FakeAudioContext.made.filter((c) => !c.closed).length;
  }
}

const originals: Record<string, any> = {};

beforeEach(() => {
  FakeAudioContext.made = [];
  for (const name of ["AudioContext", "MediaStream"]) originals[name] = (globalThis as any)[name];
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).MediaStream = class {
    constructor(public tracks: unknown[]) {}
  };
});

afterEach(async () => {
  await stopScribe();
  for (const [name, value] of Object.entries(originals)) (globalThis as any)[name] = value;
});

/** A room with one microphone in it: the least that makes the scribe open a pipe. */
function fakeRoom(trackSid: string) {
  const publication = {
    trackSid,
    isSubscribed: true,
    track: { mediaStreamTrack: { readyState: "live" } },
  };
  return {
    localParticipant: {
      identity: "u-me",
      name: "Me",
      getTrackPublication: (source: unknown) =>
        source === Track.Source.Microphone ? publication : undefined,
    },
    remoteParticipants: new Map(),
    on() {},
    off() {},
  } as any;
}

/** A deployment where transcription cannot start: every mint is refused. */
function refusingConvex() {
  return {
    mutation: async () => ({ transcript_id: "tr-1" }),
    action: async () => ({ error: "Transcription is not configured" }),
  } as any;
}

/** Let the mint round trip and the failure path that follows it run. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("the scribe hands back what it opened", () => {
  test("a pipe whose mint is refused gives its microphone back, rather than being forgotten with it", async () => {
    await startScribe({ convex: refusingConvex(), room: fakeRoom("sid-1"), roomKey: "room:1" });
    // The pipe opened and started capturing before the mint could refuse it.
    expect(FakeAudioContext.made.length).toBe(1);

    await settle();
    // Forgotten by the scribe AND closed — those were two different things, and
    // only doing the first is the leak.
    expect(getScribeStatus().trackCount).toBe(0);
    expect(FakeAudioContext.open()).toBe(0);
  });

  test("re-attaching in a huddle where the mint keeps failing does not accumulate them", async () => {
    const convex = refusingConvex();
    await startScribe({ convex, room: fakeRoom("sid-1"), roomKey: "room:1" });
    await settle();

    // What TrackSubscribed does on every reconnect and every republish: the
    // scribe re-attaches, and the pipe fails again. Ten times over a long call.
    for (let i = 0; i < 10; i++) {
      await stopScribe();
      await startScribe({ convex, room: fakeRoom(`sid-${i}`), roomKey: "room:1" });
      await settle();
    }
    expect(FakeAudioContext.made.length).toBeGreaterThan(10);
    expect(FakeAudioContext.open()).toBe(0);
  });

  test("stopping the scribe closes a pipe that is working perfectly well", async () => {
    // The other half of the same rule: the map is the scribe's whole record of
    // what it owes, so a pipe in it must always be closable from it.
    const convex = {
      mutation: async () => ({ transcript_id: "tr-1" }),
      // A mint that never answers: the pipe stays open, capturing, in the map.
      action: () => new Promise(() => {}),
    } as any;
    await startScribe({ convex, room: fakeRoom("sid-1"), roomKey: "room:1" });
    await settle();
    expect(getScribeStatus().trackCount).toBe(1);
    expect(FakeAudioContext.open()).toBe(1);

    await stopScribe();
    expect(FakeAudioContext.open()).toBe(0);
  });
});

// Every huddle transcribes, so several seated clients ask to scribe the same
// room. The server answers one of them "scribe" and the rest "observer"; an
// observer must open NOTHING — a pipe per track here would append every word
// a second time, and hold a recognizer for the length of the call.
describe("an observer opens no pipe", () => {
  test("the server's observer verdict leaves the scribe idle and the microphone alone", async () => {
    const convex = {
      mutation: async () => ({ transcript_id: "tr-1", existing: true, role: "observer" }),
      action: async () => ({ error: "must not be called" }),
    } as any;
    const started = await startScribe({ convex, room: fakeRoom("sid-1"), roomKey: "room:1", auto: true });
    expect(started).toBe(false);
    expect(getScribeStatus().active).toBe(false);
    expect(FakeAudioContext.made.length).toBe(0);
  });

  test("the room's opt-out answers an auto start the same way", async () => {
    const convex = {
      mutation: async () => ({ transcript_id: null, existing: false, role: "off" }),
      action: async () => ({ error: "must not be called" }),
    } as any;
    expect(await startScribe({ convex, room: fakeRoom("sid-1"), roomKey: "room:1", auto: true })).toBe(false);
    expect(FakeAudioContext.made.length).toBe(0);
  });

  test("a scribe verdict arms the run", async () => {
    const convex = {
      mutation: async () => ({ transcript_id: "tr-1", existing: false, role: "scribe" }),
      action: () => new Promise(() => {}),
    } as any;
    expect(await startScribe({ convex, room: fakeRoom("sid-1"), roomKey: "room:1", auto: true })).toBe(true);
    expect(getScribeStatus().active).toBe(true);
    expect(getScribeStatus().trackCount).toBe(1);
  });
});
