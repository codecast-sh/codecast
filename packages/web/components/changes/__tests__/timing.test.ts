import { describe, expect, it } from "bun:test";
import { clockOf, gapOf, stampOf, waitingOn } from "../StoryParts";
import { localDay } from "../../../lib/changesDay";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe("gapOf", () => {
  it("reads minutes, hours and days", () => {
    expect(gapOf(45 * 60_000)).toBe("45m");
    expect(gapOf(93 * 60_000)).toBe("1h 33m");
    expect(gapOf(120 * 60_000)).toBe("2h");
    expect(gapOf(52 * 3_600_000)).toBe("2d 4h");
    expect(gapOf(-5000)).toBe("0m");
  });
});

describe("stampOf", () => {
  it("says the day only when it is not the story's", () => {
    const landed = at(2026, 10, 21, 14, 32);
    const day = localDay(0, landed);
    expect(stampOf(landed, day)).toBe(clockOf(landed));
    const next = at(2026, 10, 22, 9, 5);
    expect(stampOf(next, day)).toBe(`Thu 22 Oct ${clockOf(next)}`);
  });
});

describe("waitingOn", () => {
  const live = [
    { surface: "backend", at: 1000 },
    { surface: "release", at: 5000 },
  ] as any[];
  it("names the surfaces whose last ship came before the story landed", () => {
    expect(waitingOn({ area: "convex", last_at: 2000, on_default_branch: true }, live).map((l) => l.surface)).toEqual(["backend"]);
    expect(waitingOn({ area: "convex", last_at: 9000, on_default_branch: true }, live).map((l) => l.surface)).toEqual(["backend", "release"]);
  });
  it("never holds a branch story against a deploy", () => {
    expect(waitingOn({ area: "convex", last_at: 9000, on_default_branch: false }, live)).toEqual([]);
  });
});
