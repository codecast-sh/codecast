import { describe, expect, it } from "bun:test";
import {
  CENTER_CROP,
  clampCrop,
  cropBox,
  cropFromFace,
  cropTransform,
  facePeople,
  facesToShow,
  facesWindowSize,
  hitsInteractive,
  lerpCrop,
  naturalTier,
  pickSpeaker,
  tierForWidth,
  CHROME_WIDTH,
  HOVER_ROWS,
  FACE_GAP,
  FACES_PADDING,
  TIER_DIAMETER,
  type Crop,
} from "../calls/faceCrop";

// The floating faces are a circle of somebody's face over their work, so the
// failures that matter are visual and continuous: a circle that twitches, one
// that shows the desktop through its edge, one that swaps faces mid-word.
// Every one of those is decided by a pure function, and they are pinned here.

const VIDEO = { w: 640, h: 480 };
const ASPECT = VIDEO.w / VIDEO.h;

describe("cropFromFace", () => {
  it("centers on the face and leaves room around it", () => {
    // A 100px-tall face in the middle of the frame.
    const crop = cropFromFace({ x: 270, y: 190, width: 100, height: 100 }, VIDEO.w, VIDEO.h);
    expect(crop.cx).toBeCloseTo(320 / 640, 5);
    expect(crop.cy).toBeCloseTo(240 / 480, 5);
    // The crop is the face plus padding, not the face box.
    expect(crop.size).toBeCloseTo((100 * 2.1) / 480, 5);
    expect(crop.size).toBeGreaterThan(100 / 480);
  });

  it("falls back to the center when the frame has no dimensions yet", () => {
    expect(cropFromFace({ x: 0, y: 0, width: 10, height: 10 }, 0, 0)).toEqual(CENTER_CROP);
  });
});

describe("clampCrop", () => {
  it("keeps the square inside the frame when the face is at the edge", () => {
    const crop = clampCrop({ cx: 0.02, cy: 0.02, size: 0.5 }, ASPECT);
    const halfW = crop.size / (2 * ASPECT);
    expect(crop.cx).toBeCloseTo(halfW, 6);
    expect(crop.cy).toBeCloseTo(0.25, 6);
    // The whole square is inside [0,1] on both axes — no transparent hole.
    expect(crop.cx - halfW).toBeGreaterThanOrEqual(-1e-9);
    expect(crop.cy + crop.size / 2).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("shrinks a crop that is taller than the frame", () => {
    expect(clampCrop({ cx: 0.5, cy: 0.5, size: 3 }, ASPECT).size).toBe(1);
  });

  it("shrinks to the width on a frame taller than it is wide", () => {
    // A portrait frame (aspect 0.75) cannot show a full-height square.
    expect(clampCrop({ cx: 0.5, cy: 0.5, size: 1 }, 0.75).size).toBe(0.75);
  });

  it("leaves a crop that already fits alone", () => {
    const crop = { cx: 0.5, cy: 0.5, size: 0.4 };
    expect(clampCrop(crop, ASPECT)).toEqual(crop);
  });
});

describe("lerpCrop", () => {
  it("ignores movement below the deadzone, and says so by identity", () => {
    const cur: Crop = { cx: 0.5, cy: 0.5, size: 0.4 };
    const target: Crop = { cx: 0.502, cy: 0.5, size: 0.4 };
    expect(lerpCrop(cur, target, 0.2)).toBe(cur);
  });

  it("moves a fraction of the way toward a real move", () => {
    const cur: Crop = { cx: 0.5, cy: 0.5, size: 0.4 };
    const next = lerpCrop(cur, { cx: 0.7, cy: 0.5, size: 0.4 }, 0.25);
    expect(next.cx).toBeCloseTo(0.55, 6);
    expect(next).not.toBe(cur);
  });

  it("converges without overshooting", () => {
    let crop: Crop = { cx: 0.2, cy: 0.2, size: 0.3 };
    const target: Crop = { cx: 0.8, cy: 0.6, size: 0.5 };
    for (let i = 0; i < 200; i++) crop = lerpCrop(crop, target, 0.2);
    expect(crop.cx).toBeCloseTo(target.cx, 2);
    expect(crop.cy).toBeCloseTo(target.cy, 2);
    expect(crop.size).toBeCloseTo(target.size, 2);
    expect(crop.cx).toBeLessThanOrEqual(target.cx);
  });

  it("clamps alpha, so a bad rate cannot fling the crop past its target", () => {
    const next = lerpCrop({ cx: 0.2, cy: 0.5, size: 0.4 }, { cx: 0.8, cy: 0.5, size: 0.4 }, 5);
    expect(next.cx).toBeCloseTo(0.8, 6);
  });
});

describe("cropBox", () => {
  it("scales the video so the crop side fills the circle", () => {
    const box = cropBox({ cx: 0.5, cy: 0.5, size: 0.5 }, 120, ASPECT);
    // Half the frame height must become 120px, so the frame is 240 tall.
    expect(box.height).toBeCloseTo(240, 6);
    expect(box.width).toBeCloseTo(320, 6);
    // Centered crop → the frame's center sits at the circle's center.
    expect(box.left).toBeCloseTo(60 - 160, 6);
    expect(box.top).toBeCloseTo(60 - 120, 6);
  });

  it("puts the crop's center at the circle's center wherever the face is", () => {
    const d = 120;
    const crop = { cx: 0.3, cy: 0.7, size: 0.4 };
    const box = cropBox(crop, d, ASPECT);
    expect(box.left + crop.cx * box.width).toBeCloseTo(d / 2, 6);
    expect(box.top + crop.cy * box.height).toBeCloseTo(d / 2, 6);
  });

  it("covers the circle: the scaled frame overhangs it on both axes", () => {
    const d = 120;
    const box = cropBox(clampCrop({ cx: 0.5, cy: 0.5, size: 0.6 }, ASPECT), d, ASPECT);
    expect(box.left).toBeLessThanOrEqual(0);
    expect(box.top).toBeLessThanOrEqual(0);
    expect(box.left + box.width).toBeGreaterThanOrEqual(d);
    expect(box.top + box.height).toBeGreaterThanOrEqual(d);
  });
});

describe("cropTransform", () => {
  const D = 120;
  // Apply the transform the way the browser would: the element is a D×D box
  // with transform-origin 0 0, so a point x in it lands at tx + sx*x.
  const parse = (t: string) => {
    const [tx, ty] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(t)!.slice(1).map(Number);
    const [sx, sy] = /scale\(([-\d.]+), ([-\d.]+)\)/.exec(t)!.slice(1).map(Number);
    return { tx, ty, sx, sy };
  };

  it("lands the crop's center at the circle's center", () => {
    const crop = clampCrop({ cx: 0.35, cy: 0.6, size: 0.5 }, ASPECT);
    const box = cropBox(crop, D, ASPECT);
    const { tx, ty, sx, sy } = parse(cropTransform(box, D));
    // The face's point within the element box, then through the transform.
    // Sub-pixel: the transform string rounds, deliberately — it is written on
    // every animation frame and the extra digits buy nothing anyone can see.
    expect(tx + sx * (crop.cx * D)).toBeCloseTo(D / 2, 1);
    expect(ty + sy * (crop.cy * D)).toBeCloseTo(D / 2, 1);
  });

  it("mirrors about the circle, still centered on the face", () => {
    const crop = clampCrop({ cx: 0.35, cy: 0.6, size: 0.5 }, ASPECT);
    const box = cropBox(crop, D, ASPECT);
    const { tx, ty, sx, sy } = parse(cropTransform(box, D, true));
    expect(sx).toBeLessThan(0);
    expect(tx + sx * (crop.cx * D)).toBeCloseTo(D / 2, 1);
    expect(ty + sy * (crop.cy * D)).toBeCloseTo(D / 2, 1);
  });

  it("keeps the frame covering the circle after mirroring", () => {
    const box = cropBox(clampCrop(CENTER_CROP, ASPECT), D, ASPECT);
    const { tx, sx } = parse(cropTransform(box, D, true));
    const edges = [tx, tx + sx * D].sort((a, b) => a - b);
    expect(edges[0]).toBeLessThanOrEqual(0);
    expect(edges[1]).toBeGreaterThanOrEqual(D);
  });
});

describe("pickSpeaker", () => {
  const T = 1_000_000;

  it("takes the first voice of the call immediately", () => {
    expect(pickSpeaker({ id: null, since: 0 }, ["riley"], T)).toEqual({ id: "riley", since: T });
  });

  it("holds the current face through silence", () => {
    const prev = { id: "riley", since: T };
    expect(pickSpeaker(prev, [], T + 9000)).toBe(prev);
  });

  it("refuses a swap while the current face is still fresh", () => {
    const prev = { id: "riley", since: T };
    expect(pickSpeaker(prev, ["jordan"], T + 800)).toBe(prev);
  });

  it("swaps once the new voice has held the floor", () => {
    const prev = { id: "riley", since: T };
    expect(pickSpeaker(prev, ["jordan"], T + 1500)).toEqual({ id: "jordan", since: T + 1500 });
  });

  it("does not restart the clock on the face already showing", () => {
    const prev = { id: "riley", since: T };
    expect(pickSpeaker(prev, ["riley"], T + 4000)).toBe(prev);
  });

  it("cannot be flapped by two people trading interjections", () => {
    // Riley speaks; Jordan cuts in for under the hold, twice. The circle must
    // still be on Riley — otherwise the frame swaps on every "mhm".
    let pick = pickSpeaker({ id: null, since: 0 }, ["riley"], T);
    pick = pickSpeaker(pick, ["jordan"], T + 400);
    pick = pickSpeaker(pick, ["riley"], T + 700);
    pick = pickSpeaker(pick, ["jordan"], T + 1100);
    expect(pick.id).toBe("riley");
  });
});

describe("facePeople", () => {
  const roster = [
    { user_id: "riley", user_name: "Riley Chen", user_image: "r.png", muted: false },
    { user_id: "jordan", user_name: "Jordan Lee", muted: true },
  ];
  const tiles = [{ identity: "riley", name: "Riley Chen", isLocal: true }];

  it("keeps roster order and marks who is on camera", () => {
    const people = facePeople(roster, tiles, "riley");
    expect(people.map((p) => p.id)).toEqual(["riley", "jordan"]);
    expect(people[0]).toMatchObject({ isLocal: true, hasVideo: true, muted: false });
    expect(people[1]).toMatchObject({ isLocal: false, hasVideo: false, muted: true });
  });

  it("gives a circle to a camera that arrived before its occupancy row", () => {
    const people = facePeople(roster, [...tiles, { identity: "sam", name: "Sam", isLocal: false }], "riley");
    expect(people.map((p) => p.id)).toEqual(["riley", "jordan", "sam"]);
    expect(people[2].hasVideo).toBe(true);
  });

  it("survives a roster row with no id, and never doubles a person", () => {
    const people = facePeople([...roster, { user_name: "ghost" }, roster[0]], tiles, "riley");
    expect(people.map((p) => p.id)).toEqual(["riley", "jordan"]);
  });
});

describe("facesToShow", () => {
  const me = { id: "riley", name: "Riley", isLocal: true, muted: false, hasVideo: true };
  const them = { id: "jordan", name: "Jordan", isLocal: false, muted: false, hasVideo: true };

  it("shows the other people, not you", () => {
    expect(facesToShow([me, them]).map((p) => p.id)).toEqual(["jordan"]);
  });

  it("shows you when nobody else is here yet", () => {
    expect(facesToShow([me]).map((p) => p.id)).toEqual(["riley"]);
  });
});

describe("hitsInteractive", () => {
  const circle = { kind: "circle", cx: 60, cy: 60, r: 36 } as const;
  const chrome = { kind: "rect", x: 20, y: 100, width: 80, height: 24 } as const;

  it("takes the pointer inside a face", () => {
    expect(hitsInteractive([circle], 60, 60)).toBe(true);
    expect(hitsInteractive([circle], 60, 95)).toBe(true);
  });

  it("lets the pointer through the corners of the circle's box", () => {
    // The square corner around a circle is where the window is transparent and
    // the click belongs to whatever is underneath.
    expect(hitsInteractive([circle], 26, 26)).toBe(false);
  });

  it("takes the pointer on the chrome row", () => {
    expect(hitsInteractive([circle, chrome], 30, 110)).toBe(true);
    expect(hitsInteractive([circle, chrome], 30, 130)).toBe(false);
  });

  it("passes everything through when there is nothing to hit", () => {
    expect(hitsInteractive([], 60, 60)).toBe(false);
  });
});

describe("the circle tiers", () => {
  it("is 96 for one speaker, 64 in a row, 40 when squeezed", () => {
    expect(TIER_DIAMETER).toEqual({ speaker: 96, row: 64, mini: 40 });
  });

  it("puts one circle at the speaker size and a row at the row size", () => {
    expect(naturalTier("speaker")).toBe("speaker");
    expect(naturalTier("everyone")).toBe("row");
  });

  it("drops to mini below the width its own circles want", () => {
    const row = facesWindowSize("everyone", 3).width;
    expect(tierForWidth(row, "everyone", 3)).toBe("row");
    expect(tierForWidth(row - 1, "everyone", 3)).toBe("mini");
  });

  it("drops a single speaker circle to mini too", () => {
    const speaker = facesWindowSize("speaker", 1).width;
    expect(tierForWidth(speaker, "speaker", 1)).toBe("speaker");
    expect(tierForWidth(speaker - 1, "speaker", 1)).toBe("mini");
  });
});

describe("facesWindowSize", () => {
  it("is the circles' bounds plus 8px, and nothing else", () => {
    // The whole point of the exact bounds: no chrome row waiting under the
    // faces, no padding kept back for a state the window is not in.
    expect(facesWindowSize("speaker", 1)).toEqual({
      width: TIER_DIAMETER.speaker + FACES_PADDING * 2,
      height: TIER_DIAMETER.speaker + FACES_PADDING * 2,
    });
    expect(facesWindowSize("everyone", 3)).toEqual({
      width: 3 * TIER_DIAMETER.row + 2 * FACE_GAP + FACES_PADDING * 2,
      height: TIER_DIAMETER.row + FACES_PADDING * 2,
    });
  });

  it("is one circle wide in speaker mode, whoever else is in the call", () => {
    expect(facesWindowSize("speaker", 5)).toEqual(facesWindowSize("speaker", 1));
  });

  it("grows by a circle and a gap per person in everyone mode", () => {
    const one = facesWindowSize("everyone", 1);
    const two = facesWindowSize("everyone", 2);
    expect(two.width - one.width).toBe(TIER_DIAMETER.row + FACE_GAP);
    expect(two.height).toBe(one.height);
  });

  it("never collapses to nothing when the room is empty", () => {
    expect(facesWindowSize("everyone", 0).width).toBe(facesWindowSize("everyone", 1).width);
  });

  it("shrinks the circles, and the window with them, at the mini tier", () => {
    const mini = facesWindowSize("everyone", 3, { tier: "mini" });
    expect(mini.height).toBe(TIER_DIAMETER.mini + FACES_PADDING * 2);
    expect(mini.width).toBeLessThan(facesWindowSize("everyone", 3).width);
  });

  it("grows downward on hover, to hold the name and the controls", () => {
    // Both rows live BELOW the circles, so this is the only way they fit
    // without covering a face.
    const idle = facesWindowSize("everyone", 3);
    const hovered = facesWindowSize("everyone", 3, { hovered: true });
    expect(hovered.height - idle.height).toBe(HOVER_ROWS);
    // Three 64px faces are already wider than the chrome, so the width holds.
    expect(hovered.width).toBe(idle.width);
  });

  it("widens too, but only where the chrome would be clipped", () => {
    // One 96px face is narrower than four 28px buttons, so hovering it has to
    // make room sideways as well.
    const hovered = facesWindowSize("speaker", 1, { hovered: true });
    expect(hovered.width).toBe(CHROME_WIDTH + FACES_PADDING * 2);
    expect(hovered.height).toBe(TIER_DIAMETER.speaker + HOVER_ROWS + FACES_PADDING * 2);
  });

  it("never reserves either row while the pointer is away", () => {
    for (const tier of ["speaker", "row", "mini"] as const) {
      const idle = facesWindowSize("everyone", 1, { tier });
      expect(idle.height).toBe(TIER_DIAMETER[tier] + FACES_PADDING * 2);
    }
  });
});
