import { describe, expect, it } from "bun:test";
import {
  COMPACT_MAX_H,
  COMPACT_MAX_W,
  STRIP_FACE_PX,
  STRIP_MAX_H,
  densityFor,
} from "./peopleDensity";
import { WALL_FACE_PX } from "./peopleWallLayout";

describe("density from the window's own box", () => {
  it("is a strip when the window is too short for a header and a list", () => {
    expect(densityFor(600, STRIP_MAX_H - 1)).toBe("strip");
    expect(densityFor(180, 56)).toBe("strip");
  });

  it("is compact when narrow OR short", () => {
    expect(densityFor(COMPACT_MAX_W - 1, 800)).toBe("compact");
    expect(densityFor(600, COMPACT_MAX_H - 1)).toBe("compact");
  });

  it("is full at the window's default size and above", () => {
    expect(densityFor(320, 640)).toBe("full");
    expect(densityFor(COMPACT_MAX_W, COMPACT_MAX_H)).toBe("full");
  });

  it("strip beats compact: a short sliver is a strip whatever its width", () => {
    expect(densityFor(200, STRIP_MAX_H - 1)).toBe("strip");
  });
});

describe("strip face sizes", () => {
  it("keep the wall's order — the biggest face is still the busiest person", () => {
    expect(STRIP_FACE_PX.loud).toBeGreaterThan(STRIP_FACE_PX.here);
    expect(STRIP_FACE_PX.here).toBeGreaterThan(STRIP_FACE_PX.idle);
    expect(STRIP_FACE_PX.idle).toBeGreaterThan(STRIP_FACE_PX.away);
  });

  it("are each smaller than the wall's, so the strip never outgrows its row", () => {
    for (const tier of Object.keys(WALL_FACE_PX) as (keyof typeof WALL_FACE_PX)[]) {
      expect(STRIP_FACE_PX[tier]).toBeLessThan(WALL_FACE_PX[tier]);
    }
  });
});
