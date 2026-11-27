import { describe, expect, test } from "bun:test";
import { markerRadius, markerShapes } from "./markerGeometry";

describe("markerShapes", () => {
  test("radius is 2.2% of the short side, at least 11px", () => {
    expect(markerRadius(2000, 1000)).toBe(22);
    expect(markerRadius(300, 200)).toBe(11);
  });

  test("the badge sits up and to the right of the point, tied by a stem from the ring's edge", () => {
    const [m] = markerShapes([{ x: 0.5, y: 0.5, number: 3 }], 2000, 1000);
    const k = 22 * 0.55;
    expect(m.number).toBe(3);
    expect(m.ring).toEqual({ x: 1000, y: 500, r: k });
    expect(m.badge).toEqual({ x: 1044, y: 456, r: 22 });
    expect(m.stem).toEqual({ x1: 1000 + k * Math.SQRT1_2, y1: 500 - k * Math.SQRT1_2, x2: 1044, y2: 456 });
    expect(m.text).toEqual({ x: 1044, y: 456 + 22 * 0.06, size: 25 });
  });

  test("near the top-right corner the badge flips down and left to stay on the picture", () => {
    const [m] = markerShapes([{ x: 0.99, y: 0.01, number: 1 }], 1000, 1000);
    expect(m.badge.x).toBeLessThan(m.ring.x);
    expect(m.badge.y).toBeGreaterThan(m.ring.y);
  });
});
