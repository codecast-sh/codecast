import { describe, expect, it } from "bun:test";
import { landBurst, measureBurst, pickLiveBurst, type LiveBurstRow } from "../calls/walkie";

// Which live burst a client should open its ears for. The rules are small and
// the consequences are loud — this is the function that decides whether a
// voice comes out of somebody's speakers — so they are pinned here.

const NOW = 1_700_000_000_000;

const row = (over: Partial<LiveBurstRow>): LiveBurstRow => ({
  messageId: "m1",
  channelId: "c1",
  roomKey: "dm:a:b",
  fromUserId: "u1",
  fromName: "Sam",
  createdAt: NOW - 1_000,
  ...over,
});

describe("walkie: choosing the burst to hear", () => {
  it("hears nobody when nobody is talking", () => {
    expect(pickLiveBurst([], NOW)).toBeNull();
  });

  it("hears the most recent speaker when two people key up", () => {
    const older = row({ messageId: "old", createdAt: NOW - 20_000 });
    const newer = row({ messageId: "new", createdAt: NOW - 2_000 });
    // Order in the payload must not decide it; the clock does.
    expect(pickLiveBurst([newer, older], NOW)?.messageId).toBe("new");
    expect(pickLiveBurst([older, newer], NOW)?.messageId).toBe("new");
  });

  it("ignores a burst with no room to join", () => {
    expect(pickLiveBurst([row({ roomKey: undefined })], NOW)).toBeNull();
  });

  it("ignores a row past the server's live window — that tab died mid-word", () => {
    expect(pickLiveBurst([row({ createdAt: NOW - 120_001 })], NOW)).toBeNull();
    // And a stale row does not shadow a real one behind it.
    const live = row({ messageId: "live", createdAt: NOW - 3_000 });
    const dead = row({ messageId: "dead", createdAt: NOW - 300_000 });
    expect(pickLiveBurst([dead, live], NOW)?.messageId).toBe("live");
  });
});

// What a burst's last round trip is allowed to conclude. The sender's own
// bubble is painted from this answer, and the wrong answer is the worst of the
// three states: a message that reads sent and playable to the person who spoke
// it, and does not exist for the person it was spoken to.
describe("walkie: landing a burst", () => {
  const ARGS = {
    messageId: "msg1",
    content: "back in five",
    durationMs: 1500,
    attachments: [{ storage_id: "st1", mime: "audio/webm", name: "voice.webm" }],
  };

  function fakeConvex(behavior: Record<string, "ok" | "throw">) {
    const calls: string[] = [];
    return {
      calls,
      handle: {
        action: async () => null,
        mutation: async (_fn: any, args: any) => {
          // Told apart by the call itself: only a finalize carries the words.
          const name = args.content === undefined ? "cancel" : "finalize";
          calls.push(name);
          if (behavior[name] === "throw") throw new Error(name + " refused");
          return { message_id: args.message_id };
        },
      },
    };
  }

  it("lands the message when the server takes it", async () => {
    const c = fakeConvex({ finalize: "ok" });
    expect(await landBurst(c.handle, ARGS)).toBe("landed");
    expect(c.calls).toEqual(["finalize"]);
  });

  it("cancels the burst when it cannot be finalized — the audio is over, it cannot be retried later", async () => {
    const c = fakeConvex({ finalize: "throw", cancel: "ok" });
    expect(await landBurst(c.handle, ARGS)).toBe("cancelled");
    expect(c.calls).toEqual(["finalize", "cancel"]);
  });

  it("says so when nobody answered, rather than claiming either outcome", async () => {
    // Both halves failing is the network being gone. The row is still live on
    // the server, and the sweep there — not this client — decides its fate.
    const c = fakeConvex({ finalize: "throw", cancel: "throw" });
    expect(await landBurst(c.handle, ARGS)).toBe("unresolved");
    expect(c.calls).toEqual(["finalize", "cancel"]);
  });
});

// The brushed key. MIN_BURST_MS throws away a hold too short to be speech, and
// it only works if the hold is measured from the hand, not from the clock the
// setup happens to be on. Measuring the burst from press to "setup finished"
// charged mic acquisition, the room join and the start round trip to the
// person's thumb: a real 60ms tap reported 1274ms, so the guard never fired
// once and every brushed key posted a wordless voice note.
describe("walkie: measuring a burst", () => {
  const PRESS = 1_000_000;
  // What setup actually cost on a warm room in the browser: about 1.2 seconds.
  const SETUP_MS = 1_200;

  const measure = (holdMs: number, over: Partial<Parameters<typeof measureBurst>[0]> = {}) =>
    measureBurst({
      startedAt: PRESS,
      captureAt: PRESS + SETUP_MS,
      releasedAt: PRESS + holdMs,
      stoppedAt: PRESS + Math.max(holdMs, SETUP_MS),
      transcript: "",
      hasAudio: true,
      ...over,
    });

  it("throws away a brushed key even when the setup it raced took a second", () => {
    expect(measure(60).discard).toBe(true);
    expect(measure(300).discard).toBe(true);
    expect(measure(699).discard).toBe(true);
  });

  it("keeps a hold that reached the threshold", () => {
    expect(measure(700).discard).toBe(false);
    expect(measure(25_000).discard).toBe(false);
  });

  it("reports the recording's own span, not the setup that preceded it", () => {
    // 25s of hold on a room that took 1.2s to open is 23.8s of audio.
    expect(measure(25_000).durationMs).toBe(23_800);
  });

  it("falls back to the hold when there was no recorder to run", () => {
    // An old browser or a blocked codec: live audio and a transcript, no
    // recording. The hold is then the only span there is.
    const m = measure(4_000, { captureAt: null, transcript: "on my way" });
    expect(m.durationMs).toBe(4_000);
    expect(m.discard).toBe(false);
  });

  it("never reports a negative span when the release beat the setup", () => {
    const m = measure(200, { stoppedAt: PRESS + SETUP_MS - 100 });
    expect(m.durationMs).toBe(0);
    expect(m.discard).toBe(true);
  });

  it("throws away a real hold that carried neither words nor audio", () => {
    expect(measure(5_000, { hasAudio: false }).discard).toBe(true);
    // Audio with nothing recognized is still a voice note.
    expect(measure(5_000, { hasAudio: true }).discard).toBe(false);
    // As is a transcript with no recording behind it.
    expect(measure(5_000, { hasAudio: false, transcript: "on my way" }).discard).toBe(false);
    // Whitespace is not words.
    expect(measure(5_000, { hasAudio: false, transcript: "   " }).discard).toBe(true);
  });
});
