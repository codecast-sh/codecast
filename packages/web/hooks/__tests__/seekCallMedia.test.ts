import { describe, expect, it } from "bun:test";
import { seekCallMedia, type CallMediaTarget } from "../useCallMomentLanding";

// The one seek both call pages use: a line pressed plays from there, a linked
// moment waits there, and the lit line moves in the same frame either way.
function target(over: { hasVideo: boolean; seekAnswers?: boolean }) {
  const log: { sets: unknown[]; missed: unknown[]; seeks: unknown[]; played: number } = { sets: [], missed: [], seeks: [], played: 0 };
  const audio = { currentTime: 0, play: () => ((log.played += 1), Promise.resolve()) } as unknown as HTMLAudioElement;
  const t: CallMediaTarget = {
    hasVideo: over.hasVideo,
    player: { current: { seek: (ms: number, opts?: unknown) => (log.seeks.push([ms, opts]), over.seekAnswers ?? true) } },
    audio: { current: audio },
    media: { set: (at) => void log.sets.push(at) },
    setMissed: (ms) => void log.missed.push(ms),
  };
  return { t, log, audio };
}

describe("seekCallMedia", () => {
  it("plays audio from the line and lights it at once", () => {
    const { t, log, audio } = target({ hasVideo: false });
    seekCallMedia(t, 12_500);
    expect(audio.currentTime).toBe(12.5);
    expect(log.played).toBe(1);
    expect(log.sets).toEqual([{ ms: 12_500, playing: true }]);
  });

  it("lands on a moment without playing", () => {
    const { t, log } = target({ hasVideo: false });
    seekCallMedia(t, 4_000, { play: false });
    expect(log.played).toBe(0);
    expect(log.sets).toEqual([{ ms: 4_000, playing: false }]);
  });

  it("leaves a playing video to report its own time, and says a moment it does not show", () => {
    const { t, log } = target({ hasVideo: true, seekAnswers: false });
    seekCallMedia(t, 9_000);
    expect(log.seeks).toEqual([[9_000, { play: true, view: undefined }]]);
    expect(log.missed).toEqual([9_000]);
    expect(log.sets).toEqual([]);
  });

  it("lights the line of a paused landing on video, on the view asked for", () => {
    const { t, log } = target({ hasVideo: true });
    seekCallMedia(t, 9_000, { play: false, view: { kind: "screen" } as any });
    expect(log.missed).toEqual([null]);
    expect(log.sets).toEqual([{ ms: 9_000, playing: false }]);
  });
});
