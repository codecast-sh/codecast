import { describe, expect, it } from "bun:test";
import { wallSpend, wallWindowDays } from "./wallModel";
import { noiseFlipWords, noiseFlipsShort } from "./verdictModel";

const DAY = 24 * 60 * 60 * 1000;

describe("wallSpend", () => {
  const to = Date.UTC(2026, 9, 5, 12);
  const days = [
    { day: "2026-09-20", usd: 500, judgeUsd: 10 },
    { day: "2026-10-02", usd: 600, judgeUsd: 20 },
    { day: "2026-10-03", usd: 400, judgeUsd: 30 },
    { day: "2026-10-05", usd: 200, judgeUsd: 18 },
  ];

  it("reads one window for the header and the spend row: the days the strip draws, over the window's length", () => {
    const from = to - 3 * DAY;
    const s = wallSpend(days, from, to);
    expect(s.days).toBe(3);
    // Oct 2 began before the window but reaches into it, as the strip draws it; Sep 20 does not.
    expect(s.usd).toBe(620 + 430 + 218);
    expect(wallWindowDays(from, to)).toBe(s.days);
  });

  it("widens with the window", () => {
    expect(wallSpend(days, to - 30 * DAY, to)).toEqual({ usd: 510 + 620 + 430 + 218, days: 30 });
  });
});

describe("noise flip words", () => {
  const flip = { freezeId: "f", name: "jx7btyt:100", visibility: "private" as const, direction: "broke" as const, before: ["a"], after: ["b"] };

  it("names why a flip is not counted, short on the row and long in its title", () => {
    const noisy = { ...flip, history: { flips: 9, batches: 22 }, samePrompt: true };
    expect(noiseFlipsShort([noisy])).toBe("1 flip on noise: flaps 9 of 22, same prompt");
    expect(noiseFlipWords(noisy)).toBe("jx7btyt:100 broke, flaps: 9 of 22 batches, same prompt on both sides");
    expect(noiseFlipsShort([{ ...flip, history: { flips: 1, batches: 22 }, samePrompt: true }])).toBe("1 flip on noise: same prompt");
    expect(noiseFlipsShort([noisy, noisy])).toBe("2 flips on noise");
  });
});
