// The stash swoosh, measured rather than heard (see walkieCues.test.ts for why).

import { describe, expect, test } from "bun:test";
import { cuePeak, RENDER_SAMPLE_RATE, renderCue } from "../cueRender";
import { STASH_AWAY } from "../cueSpec";

const samples = renderCue(STASH_AWAY);
const at = (seconds: number) => Math.floor(seconds * RENDER_SAMPLE_RATE);

/** Zero crossings per second: the pitch of band-limited noise, as the ear hears it rise. */
function crossingRate(from: number, to: number): number {
  let crossings = 0;
  for (let i = at(from) + 1; i < at(to); i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return crossings / (to - from);
}

function peakBetween(from: number, to: number): number {
  let peak = 0;
  for (let i = at(from); i < at(to); i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

describe("STASH_AWAY", () => {
  test("sits in the app's band: near the new session chime, far below the kill thud", () => {
    const peak = cuePeak(STASH_AWAY);
    expect(peak).toBeGreaterThan(0.015);
    expect(peak).toBeLessThan(0.03);
  });

  // The band climbs 5.6x, but wide-band noise crosses zero at a rate between its
  // edges, so the measured rate only about doubles. A band that never moved
  // would hold near 1.
  test("the band rises: it ends far higher than it starts", () => {
    expect(crossingRate(0.16, 0.22)).toBeGreaterThan(crossingRate(0, 0.06) * 1.6);
  });

  test("it swells in instead of opening at full", () => {
    expect(peakBetween(0, 0.01)).toBeLessThan(cuePeak(STASH_AWAY) * 0.3);
  });
});
