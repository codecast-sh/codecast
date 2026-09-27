// THE ROW'S TWO WIDTHS, AND THE STYLESHEET THAT DRAWS THEM (pl-756 F2).
//
// The bar is 32px faces with compact links; the float is 64px faces (or the
// bigger size the person picked) with the call circles' margin. The numbers live once in FACE_ROW_METRICS and once in
// faceRow.css, and this file holds the two together: a window sized from the
// constants must be the window the stylesheet fills.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FACES_PADDING } from "../../../lib/calls/faceCrop";
import {
  FACE_CARD_WIDTH,
  FACE_ROW_METRICS,
  FLOAT_BAND_GAP,
  FLOAT_FACE_SIZES,
  LINK_PULL,
  faceRowSize,
  faceRowWidth,
  floatBandPlacement,
  floatFaceSizeOf,
  floatingRowSize,
  stepFloatFaceSize,
} from "../../../lib/faces/layout";

const css = readFileSync(join(import.meta.dir, "..", "faceRow.css"), "utf8");
/** The value of a custom property inside one rule of the stylesheet. */
function cssVar(rule: string, name: string): string | null {
  const block = css.split(rule)[1]?.split("}")[0] ?? "";
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? null;
}

describe("the bar", () => {
  test("32px faces, and each link pulls its pair together", () => {
    expect(FACE_ROW_METRICS.bar).toEqual({ face: 32, gap: 6, link: 14, pad: 0 });
    expect(faceRowWidth("bar", 0, 0)).toBe(0);
    expect(faceRowWidth("bar", 1, 0)).toBe(32);
    expect(faceRowWidth("bar", 3, 0)).toBe(3 * 32 + 2 * 6);
    // One bridge: a flex item of its own, so one more gap, plus its width,
    // less the share of the gap it eats each side.
    expect(faceRowWidth("bar", 3, 1)).toBeCloseTo(3 * 32 + 2 * 6 + (6 + 14 - 2 * LINK_PULL * 6));
    // A link with nobody to bridge to draws nothing.
    expect(faceRowWidth("bar", 1, 1)).toBe(32);
  });
});

describe("the float", () => {
  test("64px faces inside the call circles' margin, and nothing reserved under them", () => {
    expect(FACE_ROW_METRICS.float).toEqual({ face: 64, gap: 10, link: 26, pad: FACES_PADDING });
    expect(faceRowSize("float", 2, 1)).toEqual({
      width: 2 * FACES_PADDING + 2 * 64 + 10 + (10 + 26 - 2 * LINK_PULL * 10),
      height: 2 * FACES_PADDING + 64,
    });
    // The empty window is its margin and nothing else.
    expect(faceRowSize("float", 0, 0)).toEqual({ width: 2 * FACES_PADDING, height: 2 * FACES_PADDING + 64 });
  });
  test("the sizes: the row's own and the old call circles' tiers, remembered and stepped", () => {
    expect(FLOAT_FACE_SIZES).toEqual([64, 96, 128]);
    expect(floatFaceSizeOf(undefined)).toBe(64);
    expect(floatFaceSizeOf(128)).toBe(128);
    expect(floatFaceSizeOf(100)).toBe(64);
    expect(stepFloatFaceSize(64, 1)).toBe(96);
    expect(stepFloatFaceSize(128, 1)).toBe(128);
    expect(stepFloatFaceSize(64, -1)).toBe(64);
    // A bigger face is a bigger row, before and after the first measure.
    expect(faceRowSize("float", 3, 0, 128)).toEqual({ width: 2 * FACES_PADDING + 3 * 128 + 2 * 10, height: 2 * FACES_PADDING + 128 });
    expect(floatingRowSize(3, 0, { width: 0, height: 0 }, undefined, 128).height).toBe(2 * FACES_PADDING + 128);
  });
  test("the card hangs right under the faces, and one width holds whether or not it is up", () => {
    const card = { width: 320, height: 200 };
    const still = floatingRowSize(2, 1, card);
    // The row, the notch's gap, the card, and the row's margin under it for its shadow.
    expect(still.height).toBe(2 * FACES_PADDING + 64 + FLOAT_BAND_GAP + card.height + FACES_PADDING);
    expect(still.width).toBe(FACE_CARD_WIDTH + 2 * FACES_PADDING);
    // ONE WIDTH whether or not a card is up: the window is anchored at a
    // corner, so a window that widened when the card opened slid every face
    // sideways under the pointer. Only the height follows the card.
    const bare = floatingRowSize(2, 1, { width: 0, height: 0 });
    expect(bare.width).toBe(still.width);
    expect(bare.height).toBe(faceRowSize("float", 2, 1).height);
    const wide = floatingRowSize(6, 0, { width: 0, height: 0 });
    expect(wide.width).toBe(faceRowSize("float", 6, 0).width);
    expect(floatingRowSize(6, 0, card).width).toBe(wide.width);
    // The row as drawn wins over the arithmetic: the sum alone clipped End
    // and Join off the edge.
    const drawn = floatingRowSize(6, 1, { width: 0, height: 0 }, { width: 900, height: 80 });
    expect(drawn.width).toBe(900);
    expect(drawn.height).toBe(80);
    expect(cssVar('.face-row[data-density="float"] .face-row-below {', "top")).toBe(`calc(100% + ${FLOAT_BAND_GAP}px)`);
    expect(css).not.toContain(".face-row--hover");
  });
  test("the band slides under the pointed face and its notch points at it", () => {
    const pad = FACES_PADDING;
    // No face: the row's left margin, no notch.
    expect(floatBandPlacement(null, 900)).toEqual({ left: pad, notch: null });
    // A face in the middle of a wide row: centred under it.
    expect(floatBandPlacement(500, 900)).toEqual({ left: 500 - FACE_CARD_WIDTH / 2, notch: FACE_CARD_WIDTH / 2 });
    // The last face of a wide row (the one the card used to open far from):
    // the band stops at the right margin and the notch travels to the face.
    const end = floatBandPlacement(860, 900);
    expect(end.left).toBe(900 - pad - FACE_CARD_WIDTH);
    expect(end.left + end.notch!).toBe(860);
    // The first face: the band stops at the left margin.
    const start = floatBandPlacement(40, 900);
    expect(start.left).toBe(pad);
    expect(start.left + start.notch!).toBe(40);
    // A row narrower than the card: the band sits at the margin.
    expect(floatBandPlacement(60, 200).left).toBe(pad);
  });
});

describe("the stylesheet agrees", () => {
  test("the bar's tokens", () => {
    expect(cssVar(".face-row {", "--face")).toBe(`${FACE_ROW_METRICS.bar.face}px`);
    expect(cssVar(".face-row {", "--face-gap")).toBe(`${FACE_ROW_METRICS.bar.gap}px`);
    expect(cssVar(".face-row {", "--link-w")).toBe(`${FACE_ROW_METRICS.bar.link}px`);
  });
  test("the float's tokens and margin", () => {
    const rule = '.face-row[data-density="float"] {';
    expect(cssVar(rule, "--face")).toBe(`${FACE_ROW_METRICS.float.face}px`);
    expect(cssVar(rule, "--face-gap")).toBe(`${FACE_ROW_METRICS.float.gap}px`);
    expect(cssVar(rule, "--link-w")).toBe(`${FACE_ROW_METRICS.float.link}px`);
    expect(cssVar(rule, "padding")).toBe(`${FACE_ROW_METRICS.float.pad}px`);
  });
  test("the member card centres on the face in the bar", () => {
    // The bar's row sits inside the header with room on both sides, so the
    // card may run left of the row and only a measured viewport edge
    // (--shift, FaceCard) pushes it in: a floor at the row's own edge left
    // the first four faces with a card hanging off to the right. The float
    // places its band instead (floatBandPlacement).
    expect(cssVar(".face-card {", "--lead")).toBe("calc(var(--anchor) - var(--card-w) / 2 + var(--shift, 0px))");
  });
  test("the pull", () => {
    expect(cssVar(".face-link {", "margin")).toBe(`0 calc(var(--face-gap) * -${LINK_PULL})`);
  });
  test("the band hangs under the row and the card rides in it at both densities", () => {
    // The row renders the card inside the band (faceRow.mount: `.face-row >
    // .face-row-below > .engagement-card`); the band is what hangs, so the
    // card itself stays in flow and never wraps the seats.
    expect(cssVar(".face-row-below {", "position")).toBe("absolute");
    expect(cssVar(".face-row-below {", "top")).toBe("100%");
    expect(cssVar('.engagement-card[data-density="bar"] {', "position")).toBe("relative");
    expect(cssVar('.engagement-card[data-density="float"] {', "position")).toBe("relative");
  });
});

describe("one colour per state", () => {
  test("my warm ring starts at nothing, so the band under it keeps its own colour", () => {
    // The band is translucent: a warm ring of the band's own width under it
    // tinted my violet pink while every other seat on the line stayed blue.
    const mic = cssVar('.face-row .face[data-me][data-level="mic"] {', "box-shadow") ?? "";
    // ...outside the edge (the float's paper ring), and from zero spread.
    expect(mic).toContain("0 0 0 calc(var(--edge-w) + var(--level) * 6px)");
    expect(mic).not.toContain("calc(2px + var(--level)");
  });
  test("a call's link is the seats' violet, not a third colour between two violet faces", () => {
    expect(cssVar('.face-link[data-link-kind="call"] {', "--link-tone")).toBe("var(--sol-violet)");
    expect(cssVar('.face-link[data-link-kind="ring"] {', "--link-tone")).toBe("var(--sol-cyan)");
  });
});

describe("a face keeps its presence while its card is open", () => {
  // The lift on a face with its card open composes with the presence
  // drain: a bare brightness replaced the grayscale, and an offline photo
  // flipped to full colour the moment its card opened.
  const presence = readFileSync(join(import.meta.dir, "..", "..", "presence", "presence.css"), "utf8");
  test("the drain is a property the lift composes with", () => {
    expect(cssVar(".face-seat[data-card] .face {", "filter")).toBe("var(--drain,) brightness(1.06)");
    expect(presence).toMatch(/\.pres-av-away \{ --drain: grayscale\(60%\); \}/);
    expect(presence).toMatch(/\.pres-av-offline \{ --drain: grayscale\(100%\);/);
    expect(presence).toMatch(/\.pres-av-away,\n\.pres-av-offline \{ filter: var\(--drain\); \}/);
  });
});

describe("the two cards in the float share one plate", () => {
  test("the engagement card is solid in the float", () => {
    // The strip's 95% fill blurs the app under the header; the float has no
    // app under it, and 5% of the desktop made it a lighter plate than the
    // member card stacked under it.
    expect(cssVar(".engagement-card {", "background")).toBe("var(--sol-bg-alt)");
    expect(cssVar(".engagement-card {", "backdrop-filter")).toBe("none");
  });
});

describe("reduced motion silences the rules it names", () => {
  // A selector in the media block must carry the specificity of the rule
  // it silences, or the animation runs on: a bare `.face-link` loses to
  // `.face-link[data-link-kind]` and the pulses kept travelling.
  const reduced = css.split("@media (prefers-reduced-motion: reduce) {")[1]?.split("\n}\n")[0] ?? "";
  test("the link pulses are silenced at the kind's own specificity", () => {
    expect(reduced).toContain(".face-link[data-link-kind]::before");
    expect(reduced).toContain(".face-link[data-link-kind]::after");
    expect(reduced).toContain(".face-link[data-link-kind],");
    expect(reduced).not.toMatch(/^\s*\.face-link(::before|::after)?,?\s*$/m);
  });
});

describe("an offline face keeps the presence weight in the row", () => {
  // The call circles' `.face` base sets opacity 1 for its crossfade and ties
  // `.pres-av-offline` on specificity, so the header's offline faces sat at
  // full weight while the wall's sat at 0.45. The weight is a property the
  // row's own face rule reads.
  const presence = readFileSync(join(import.meta.dir, "..", "..", "presence", "presence.css"), "utf8");
  test("the row's face reads the weight the presence stylesheet declares", () => {
    expect(cssVar(".face-row .face {", "opacity")).toBe("var(--drain-opacity, 1)");
    expect(presence).toMatch(/\.pres-av-offline \{ --drain: grayscale\(100%\); --drain-opacity: 0\.45; \}/);
    expect(presence).toMatch(/\.pres-av-offline \{ opacity: var\(--drain-opacity\); \}/);
  });
});

describe("one focus mark for the row and its band", () => {
  // End, Mute, Join live, Snooze, Talk back, Cancel and the member card's
  // controls wore the browser's own double ring beside the face's designed
  // one. One rule names the face and every control in the band, at a
  // specificity above the ring card's own focus rule.
  test("the face and every control in the band share the cyan outline", () => {
    const rule = css.split(".face-row-below :is(button, a):focus-visible {")[1]?.split("}")[0] ?? "";
    expect(css).toContain(".face-row .face:focus-visible,\n.face-row-below :is(button, a):focus-visible {");
    expect(rule).toContain("outline: 2px solid var(--sol-cyan);");
    expect(rule).toContain("outline-offset: 2px;");
  });
  test("the ring out's lone Cancel spans the ring card's two columns", () => {
    const rule = css.split(".engagement-card .ring-card-actions > :only-child {")[1]?.split("}")[0] ?? "";
    expect(rule).toContain("grid-column: 1 / -1;");
  });
});

describe("the marks on the person sit on the circle's edge", () => {
  // The mute badge lived inside the circle, the call circles' own spot, and
  // the circle's clip cut it to a D and the icon with it. It is a mark like
  // the count and the ask: on the edge, cut out of the ring by the same band
  // of background the presence badge uses, filled with its colour.
  test("the mute badge is outside the clip, in the presence badge's corner, cut by the background", () => {
    const rule = css.split(".face-row .face-mute {")[1]?.split("}")[0] ?? "";
    expect(rule).toContain("right: -1px;");
    expect(rule).toContain("bottom: -1px;");
    expect(rule).toContain("box-shadow: 0 0 0 2px var(--sol-bg);");
    expect(rule).toContain("background: var(--sol-red);");
    expect(rule).toContain("color: var(--sol-bg);");
    expect(cssVar('.face-row[data-density="bar"] .face-mute {', "width")).toBe("14px");
  });
  test("the presence fact under the activity line speaks in its voice", () => {
    expect(cssVar(".face-card-presence {", "text-transform")).toBe("lowercase");
  });
});

describe("the ring line gives its dot room to breathe", () => {
  // The dot's ripple runs 6px past a 7px dot; a clip on the line cut it to a
  // D at the line's edge. Only the anchor title clips, and it has to be
  // allowed to shrink for the ellipsis to ever apply.
  const ring = readFileSync(join(import.meta.dir, "..", "..", "calls", "ringCard.css"), "utf8");
  const rule = (name: string) => ring.split(`${name} {`)[1]?.split("}")[0] ?? "";
  test("no clip on the line, the anchor clips itself", () => {
    expect(rule(".ring-card-line")).not.toContain("overflow:");
    expect(rule(".ring-card-anchor")).toContain("min-width: 0;");
    expect(rule(".ring-card-anchor")).toContain("overflow: hidden;");
  });
});
