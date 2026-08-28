// One arriving chat message must make exactly one sound.
//
// Two layers watch the same arrival and neither can see the other. The in-page
// toast (`useChatToasts`) reads the chat rail. The notification watcher
// (`DesktopProvider`) reads notification rows and covers the unfocused case,
// because the OS banner it raises is silent. Both were right to sound it, so
// an unfocused window blipped twice, about 15 ms apart, on every arrival — the
// nit the real-speech run heard on every voice message finalize.
//
// The collapse is keyed on the chat message id, which both feeds carry. These
// tests drive the real `soundChatMessage` and count oscillator starts, the same
// way the browser run identified cues: by the nodes they create, not by a claim
// that something played.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── a stand-in AudioContext that counts what a cue builds ──────────────────

let oscStarts = 0;
let bufferStarts = 0;

function fakeParam() {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  };
}

class FakeAudioContext {
  state = "running";
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  resume() {}
  createGain() {
    return { gain: fakeParam(), connect() {} };
  }
  createOscillator() {
    return {
      type: "sine",
      frequency: fakeParam(),
      connect() {},
      start() {
        oscStarts++;
      },
      stop() {},
    };
  }
  createBuffer(_ch: number, len: number) {
    return { getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        bufferStarts++;
      },
      stop() {},
    };
  }
  createBiquadFilter() {
    return { type: "bandpass", frequency: fakeParam(), Q: fakeParam(), connect() {} };
  }
}

(globalThis as any).AudioContext = FakeAudioContext;

// Spread the real module and override only the leader flag: `mock.module`
// replaces it for the whole test process, and a partial stand-in would break
// every other file that imports it.
const realDesktop = await import("../desktop");
let isLeader = true;
mock.module("../desktop", () => ({
  ...realDesktop,
  isNotificationLeader: () => isLeader,
}));

const { soundChatMessage, resetAudioContext } = await import("../sounds");

function setWindowRoleForTest(leader: boolean) {
  isLeader = leader;
}

describe("one arrival, one sound", () => {
  beforeEach(() => {
    oscStarts = 0;
    bufferStarts = 0;
    // sounds.ts caches one AudioContext for the whole process, so without this
    // whichever sound test file runs first pins its stand-in for the rest and
    // the others count nothing. See `resetAudioContext`.
    resetAudioContext();
    setWindowRoleForTest(true);
  });

  afterEach(() => {
    setWindowRoleForTest(true);
  });

  test("the knock motif is four oscillators and two knocks", () => {
    soundChatMessage("msg-baseline");
    // Two mallet strikes, each a fundamental plus its 4x partial, and a
    // filtered-noise transient in front of each.
    expect(oscStarts).toBe(4);
    expect(bufferStarts).toBe(2);
  });

  test("both layers answering the same message sound it once", () => {
    soundChatMessage("msg-1"); // the toast layer, off the chat rail
    soundChatMessage("msg-1"); // DesktopProvider, off the notification row
    expect(oscStarts).toBe(4);
  });

  test("two different messages still sound twice", () => {
    soundChatMessage("msg-2");
    soundChatMessage("msg-3");
    expect(oscStarts).toBe(8);
  });

  test("an unkeyed call is never collapsed", () => {
    // A caller with no message id in hand must still be heard. Silence is the
    // worse failure of the two, so an unknown key opts out of the collapse.
    soundChatMessage();
    soundChatMessage();
    expect(oscStarts).toBe(8);
  });

  test("a non-leader window stays silent and claims no key", () => {
    setWindowRoleForTest(false);
    soundChatMessage("msg-4");
    expect(oscStarts).toBe(0);

    // The suppressed call must not have consumed the key: the leader window
    // gets its sound when it observes the same message.
    setWindowRoleForTest(true);
    soundChatMessage("msg-4");
    expect(oscStarts).toBe(4);
  });
});
