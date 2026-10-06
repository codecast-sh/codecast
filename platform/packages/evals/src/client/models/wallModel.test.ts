import { describe, expect, it } from "bun:test";
import type { MovedEvent } from "../../contract";
import { evalsPaths } from "../paths";
import { movedLine, wallSpend, wallWindowDays } from "./wallModel";
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

describe("movedLine", () => {
  const { href } = evalsPaths("/admin/evals");
  const at = "2026-10-05T07:55:00.000Z";

  it("sends a shared kind to its page under the host's base", () => {
    const e: MovedEvent = { at, surface: "settle", kind: "flips", batch: "nightly-1", broke: 2, fixed: 1 };
    expect(movedLine(href, e)).toEqual({ href: href.surface("settle", { batch: "nightly-1" }), text: "settle: 2 freezes broke, 1 fixed" });
    expect(movedLine(href, { at, surface: "settle", kind: "bisect", id: "b1", outcome: null }).href).toBe("/admin/evals/bisect/b1");
  });

  it("hands a host's own kind to its drawer and keeps the line it made, extra fields and all", () => {
    type Own = { at: string; kind: "sim-failure"; run: string };
    const own = (e: Own) => ({ href: `/sim/${e.run}`, text: "sim broke", mark: "!" });
    const event: Own = { at, kind: "sim-failure", run: "r1" };
    const line = movedLine(href, event, own);
    const mark: string = "mark" in line ? line.mark : "";
    expect(line).toEqual({ href: "/sim/r1", text: "sim broke", mark: "!" });
    expect(mark).toBe("!");
  });

  it("draws a kind no one knows as a plain line home", () => {
    const stray = { at, surface: null, kind: "sim-failure" } as unknown as MovedEvent;
    expect(movedLine(href, stray)).toEqual({ href: "/admin/evals", text: "The evals moved" });
  });
});
