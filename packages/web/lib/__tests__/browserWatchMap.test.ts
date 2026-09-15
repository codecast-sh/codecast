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

import { frameContentRect, mapFromFrame, parseWatchAction } from "../browserWatch";

// The ghost cursor is drawn by the inverse mapping. It must be the exact
// inverse: an arrow drawn from an action, and a click sent from where the
// arrow points, have to name the same page point, or the human watching
// sees the agent "miss" what it clicked.

describe("mapFromFrame", () => {
  test("wide box: a normalized point lands inside the centered content", () => {
    const box = { left: 0, top: 0, width: 1000, height: 500 }; // content 800x500 at left 100
    expect(mapFromFrame(0, 0, box, natural)).toEqual({ x: 100, y: 0 });
    expect(mapFromFrame(1, 1, box, natural)).toEqual({ x: 900, y: 500 });
    expect(mapFromFrame(0.5, 0.5, box, natural)).toEqual({ x: 500, y: 250 });
  });

  test("tall box: the vertical band is skipped", () => {
    const box = { left: 0, top: 0, width: 640, height: 800 }; // content 640x400 at top 200
    expect(mapFromFrame(0, 0, box, natural)).toEqual({ x: 0, y: 200 });
    expect(mapFromFrame(0.5, 1, box, natural)).toEqual({ x: 320, y: 600 });
  });

  test("round trips through mapToFrame", () => {
    const box = { left: 37, top: 11, width: 731, height: 402 };
    for (const [nx, ny] of [[0.1, 0.9], [0.5, 0.5], [0.999, 0.001]]) {
      const p = mapFromFrame(nx, ny, box, natural)!;
      const back = mapToFrame(p.x, p.y, box, natural)!;
      expect(back.nx).toBeCloseTo(nx, 9);
      expect(back.ny).toBeCloseTo(ny, 9);
    }
  });

  test("a point past the edge is clamped to the content, not dropped", () => {
    const box = { left: 0, top: 0, width: 1000, height: 500 };
    expect(mapFromFrame(1.2, -0.5, box, natural)).toEqual({ x: 900, y: 0 });
  });

  test("degenerate sizes draw nothing", () => {
    expect(mapFromFrame(0.5, 0.5, { left: 0, top: 0, width: 0, height: 0 }, natural)).toBeNull();
    expect(mapFromFrame(0.5, 0.5, { left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
    expect(frameContentRect({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 5 })).toBeNull();
  });
});

describe("parseWatchAction", () => {
  test("keeps the fields a frame carries and nothing else", () => {
    expect(parseWatchAction({ type: "action", kind: "type", x: 0.2, y: 0.4, text: "hi", at: 5, junk: 1 })).toEqual({ kind: "type", x: 0.2, y: 0.4, text: "hi", at: 5 });
    expect(parseWatchAction({ type: "action", kind: "type", x: 0.2, y: 0.4, secret: true, at: 5 })).toEqual({ kind: "type", x: 0.2, y: 0.4, secret: true, at: 5 });
    expect(parseWatchAction({ type: "action", kind: "nav", x: 0, y: 0, url: "https://a.test/", at: 9 })).toEqual({ kind: "nav", x: 0, y: 0, url: "https://a.test/", at: 9 });
  });

  test("an unknown kind or a point that is not a number is dropped", () => {
    expect(parseWatchAction({ type: "action", kind: "dance", x: 0, y: 0, at: 1 })).toBeNull();
    expect(parseWatchAction({ type: "action", kind: "move", x: "0", y: 0, at: 1 })).toBeNull();
    expect(parseWatchAction({ type: "action", kind: "move", x: NaN, y: 0, at: 1 })).toBeNull();
    expect(parseWatchAction(null)).toBeNull();
  });

  test("a frame with no time is stamped now", () => {
    const before = Date.now();
    const a = parseWatchAction({ type: "action", kind: "up", x: 0.5, y: 0.5 })!;
    expect(a.at).toBeGreaterThanOrEqual(before);
  });
});
