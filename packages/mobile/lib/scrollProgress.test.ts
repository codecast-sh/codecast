import { describe, expect, test } from "bun:test";
import { progressStep, progressWrite } from "./scrollProgress";

describe("the transcript's position bar", () => {
  test("lands on whole device pixels of its track, inside it", () => {
    expect(progressStep(0, 144)).toBe(0);
    expect(progressStep(0.5, 144)).toBe(72);
    expect(progressStep(1, 144)).toBe(144);
    expect(progressStep(1.4, 144)).toBe(144);
    expect(progressStep(-0.2, 144)).toBe(0);
    expect(progressStep(NaN, 144)).toBe(0);
  });

  test("writes nothing while it is off screen", () => {
    expect(progressWrite(false, 0.5, 144, -1)).toBeNull();
  });

  test("writes only when the fill moves a pixel", () => {
    const first = progressWrite(true, 0.5, 144, -1);
    expect(first).toEqual({ step: 72, value: 0.5 });
    // A third of a pixel further: the same pixel, no write.
    expect(progressWrite(true, 0.5 + 1 / 432, 144, first!.step)).toBeNull();
    expect(progressWrite(true, 0.5 + 1 / 144, 144, first!.step)).toEqual({ step: 73, value: 73 / 144 });
  });

  test("a fling over a long transcript writes at most once a pixel", () => {
    // 4,000 scroll events across the whole transcript, a 48pt track at 3x.
    let last = -1;
    let writes = 0;
    for (let i = 0; i <= 4_000; i++) {
      const w = progressWrite(true, i / 4_000, 144, last);
      if (w) { writes++; last = w.step; }
    }
    expect(writes).toBe(145);
  });
});
