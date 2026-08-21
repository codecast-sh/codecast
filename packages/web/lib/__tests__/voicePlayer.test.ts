import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

// The rule the module exists to enforce: one <audio> for the whole app, so
// pressing play on a second voice note stops the first instead of talking over
// it. Everything else here is bookkeeping around that.

class FakeAudio {
  static live: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  duration = 8;
  preload = "";
  playing = false;
  private handlers: Record<string, Array<() => void>> = {};

  constructor() {
    FakeAudio.live.push(this);
  }
  addEventListener(name: string, fn: () => void) {
    (this.handlers[name] ??= []).push(fn);
  }
  fire(name: string) {
    for (const fn of this.handlers[name] ?? []) fn();
  }
  async play() {
    this.playing = true;
    this.fire("play");
  }
  pause() {
    // The real element fires `pause` only when it was actually playing.
    if (!this.playing) return;
    this.playing = false;
    this.fire("pause");
  }
}

let player: typeof import("../voicePlayer");

beforeAll(async () => {
  (globalThis as any).window ??= globalThis;
  (globalThis as any).Audio = FakeAudio;
  player = await import("../voicePlayer");
});

beforeEach(() => {
  player.stopVoice();
});

describe("voicePlayer", () => {
  test("playing a second message stops the first — one pair of ears", () => {
    player.toggleVoice("m1", "https://example.test/a.webm");
    const el = FakeAudio.live[FakeAudio.live.length - 1];
    expect(el.playing).toBe(true);
    expect(player.getVoicePlayback().key).toBe("m1");

    player.toggleVoice("m2", "https://example.test/b.webm");
    // The SAME element, re-pointed: there is never a second one to overlap.
    expect(FakeAudio.live[FakeAudio.live.length - 1]).toBe(el);
    expect(el.src).toBe("https://example.test/b.webm");
    expect(player.getVoicePlayback().key).toBe("m2");
  });

  test("pressing the message that is playing pauses it, and again resumes", () => {
    player.toggleVoice("m1", "https://example.test/a.webm");
    const el = FakeAudio.live[FakeAudio.live.length - 1];
    el.currentTime = 3;

    player.toggleVoice("m1", "https://example.test/a.webm");
    expect(el.playing).toBe(false);
    expect(player.getVoicePlayback().playing).toBe(false);
    // Paused, not rewound: picking it back up carries on where it stopped.
    expect(el.currentTime).toBe(3);

    player.toggleVoice("m1", "https://example.test/a.webm");
    expect(el.playing).toBe(true);
    expect(el.currentTime).toBe(3);
  });

  test("subscribers wake on a real change and not on a repeated one", () => {
    let wakes = 0;
    const off = player.subscribeVoicePlayer(() => wakes++);
    player.toggleVoice("m1", "https://example.test/a.webm");
    const before = wakes;
    const el = FakeAudio.live[FakeAudio.live.length - 1];
    // A timeupdate that has not crossed a second is the same snapshot; the
    // playhead is read, not scrubbed, so it must not re-render every 40ms.
    el.currentTime = 0.2;
    el.fire("timeupdate");
    expect(wakes).toBe(before);
    el.currentTime = 1.4;
    el.fire("timeupdate");
    expect(wakes).toBe(before + 1);
    off();
  });

  test("a recording that will not decode gives up quietly", () => {
    player.toggleVoice("m1", "https://example.test/a.webm");
    const el = FakeAudio.live[FakeAudio.live.length - 1];
    el.fire("error");
    // The transcript above the button already carries what was said, so there
    // is nothing to announce — just nothing playing.
    expect(player.getVoicePlayback().key).toBe(null);
    expect(player.getVoicePlayback().playing).toBe(false);
  });
});
