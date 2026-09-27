// The sounds for your own gestures, stash and kill, measured rather than heard
// (see walkieCues.test.ts for why).

import { describe, expect, test } from "bun:test";
import { cuePeak, RENDER_SAMPLE_RATE, renderCue } from "../cueRender";
import { type CueSpec, KILL_DOOR, STASH_AWAY } from "../cueSpec";

const at = (seconds: number) => Math.floor(seconds * RENDER_SAMPLE_RATE);

/** Zero crossings per second: the pitch of band-limited noise, as the ear hears it rise. */
function crossingRate(spec: CueSpec, from: number, to: number): number {
  const samples = renderCue(spec);
  let crossings = 0;
  for (let i = at(from) + 1; i < at(to); i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / (to - from);
}

function peakBetween(spec: CueSpec, from: number, to: number): number {
  const samples = renderCue(spec);
  let peak = 0;
  for (let i = at(from); i < Math.min(at(to), samples.length); i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

describe("the gesture cues sit in the app's band, near the new session chime", () => {
  for (const [name, spec] of [["stash", STASH_AWAY], ["kill", KILL_DOOR]] as const) {
    test(name, () => {
      const peak = cuePeak(spec);
      expect(peak).toBeGreaterThan(0.015);
      expect(peak).toBeLessThan(0.03);
    });
  }
});

describe("STASH_AWAY", () => {
  // The band climbs 5.6x, but wide-band noise crosses zero at a rate between its
  // edges, so the measured rate only about doubles. A band that never moved
  // would hold near 1.
  test("the band rises: it ends far higher than it starts", () => {
    expect(crossingRate(STASH_AWAY, 0.16, 0.22)).toBeGreaterThan(crossingRate(STASH_AWAY, 0, 0.06) * 1.6);
  });

  test("it swells in instead of opening at full", () => {
    expect(peakBetween(STASH_AWAY, 0, 0.01)).toBeLessThan(cuePeak(STASH_AWAY) * 0.3);
  });
});

describe("KILL_DOOR", () => {
  test("the air comes first and stays under the thud that shuts it", () => {
    expect(peakBetween(KILL_DOOR, 0, 0.09)).toBeLessThan(peakBetween(KILL_DOOR, 0.09, 0.27) * 0.6);
  });
});
