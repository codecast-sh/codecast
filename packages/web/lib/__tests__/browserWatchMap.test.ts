import { describe, expect, test } from "bun:test";
import { mapToFrame } from "../browserWatch";

// The control surface's geometry: a click on the letterboxed frame must land
// on the same page point the daemon computes from the normalized coordinates.
// Wrong math here is invisible in review — a click "works" but hits the wrong
// element a viewport-width away — so the mapping is pinned by cases.

const natural = { width: 1280, height: 800 }; // 16:10 frame

describe("mapToFrame", () => {
  test("wide box: horizontal letterbox bands, content centered", () => {
    // Box 1000x500 → scale = min(1000/1280, 500/800) = 0.625 → content 800x500
    // at left offset (1000-800)/2 = 100.
    const box = { left: 0, top: 0, width: 1000, height: 500 };
    expect(mapToFrame(100, 0, box, natural)).toEqual({ nx: 0, ny: 0 });
    expect(mapToFrame(900, 500, box, natural)).toEqual({ nx: 1, ny: 1 });
    expect(mapToFrame(500, 250, box, natural)).toEqual({ nx: 0.5, ny: 0.5 });
    // A click in the band maps to nothing rather than clamping to an edge —
    // clamping would press page elements the viewer never aimed at.
    expect(mapToFrame(50, 250, box, natural)).toBeNull();
    expect(mapToFrame(950, 250, box, natural)).toBeNull();
  });

  test("tall box: vertical letterbox bands", () => {
    // Box 640x800 → scale = 0.5 → content 640x400 at top offset 200.
    const box = { left: 0, top: 0, width: 640, height: 800 };
    expect(mapToFrame(0, 200, box, natural)).toEqual({ nx: 0, ny: 0 });
    expect(mapToFrame(640, 600, box, natural)).toEqual({ nx: 1, ny: 1 });
    expect(mapToFrame(320, 100, box, natural)).toBeNull(); // top band
  });

  test("box offset in the viewport is subtracted", () => {
    const box = { left: 200, top: 100, width: 1280, height: 800 }; // exact fit
    expect(mapToFrame(200, 100, box, natural)).toEqual({ nx: 0, ny: 0 });
    expect(mapToFrame(840, 500, box, natural)).toEqual({ nx: 0.5, ny: 0.5 });
  });

  test("degenerate sizes map to nothing instead of NaN", () => {
    expect(mapToFrame(10, 10, { left: 0, top: 0, width: 0, height: 0 }, natural)).toBeNull();
    expect(mapToFrame(10, 10, { left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
  });
});
