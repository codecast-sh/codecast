// THE ROW'S TWO WIDTHS, AND THE STYLESHEET THAT DRAWS THEM (pl-756 F2).
//
// The bar is 32px faces with compact links; the float is 64px faces with the
// call circles' margin. The numbers live once in FACE_ROW_METRICS and once in
// faceRow.css, and this file holds the two together: a window sized from the
// constants must be the window the stylesheet fills.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FACES_PADDING, NAME_HEIGHT, ROW_GAP } from "../../../lib/calls/faceCrop";
import { FACE_ROW_METRICS, LINK_PULL, faceRowSize, faceRowWidth, floatingRowSize } from "../FaceRow";

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
    // One bridge: its own width, less the share of the gap it eats each side.
    expect(faceRowWidth("bar", 3, 1)).toBeCloseTo(3 * 32 + 2 * 6 + (14 - 2 * LINK_PULL * 6));
    // A link with nobody to bridge to draws nothing.
    expect(faceRowWidth("bar", 1, 1)).toBe(32);
  });
});

describe("the float", () => {
  test("64px faces inside the call circles' margin, and the name row on hover", () => {
    expect(FACE_ROW_METRICS.float).toEqual({ face: 64, gap: 10, link: 26, pad: FACES_PADDING });
    expect(faceRowSize("float", 2, 1, false)).toEqual({
      width: 2 * FACES_PADDING + 2 * 64 + 10 + (26 - 2 * LINK_PULL * 10),
      height: 2 * FACES_PADDING + 64,
    });
    expect(faceRowSize("float", 2, 1, true).height).toBe(2 * FACES_PADDING + 64 + ROW_GAP + NAME_HEIGHT);
    // The empty window is its margin and nothing else.
    expect(faceRowSize("float", 0, 0, false)).toEqual({ width: 2 * FACES_PADDING, height: 2 * FACES_PADDING + 64 });
  });
  test("a card holds one spot: the name band is reserved under the faces whether or not the pointer is in", () => {
    // The band dropped 28px while the pointer was in the window and rose
    // again 1.5s after it left, so the card under a call moved every time
    // the hand came near it. With a card up the window is one height, and
    // the band's own rule puts the card under the name band, not the faces.
    const card = { width: 320, height: 200 };
    const still = floatingRowSize(2, 1, false, card);
    expect(floatingRowSize(2, 1, true, card)).toEqual(still);
    expect(still.height).toBe(2 * FACES_PADDING + 64 + ROW_GAP + NAME_HEIGHT + card.height);
    expect(still.width).toBe(card.width + 2 * FACES_PADDING);
    // Without a card the pointer still decides: the window is its faces.
    expect(floatingRowSize(2, 1, false, { width: 0, height: 0 })).toEqual(faceRowSize("float", 2, 1, false));
    expect(cssVar('.face-row[data-density="float"] .face-row-below {', "top")).toBe(`calc(100% + ${ROW_GAP + NAME_HEIGHT - FACES_PADDING}px)`);
    expect(css).not.toContain(".face-row--hover");
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
  test("the member card centres on the face in the bar, and floors at the window's edge in the float", () => {
    // The bar's row sits inside the header with room on both sides, so the
    // card may run left of the row and only a measured viewport edge
    // (--shift, FaceCard) pushes it in: a floor at the row's own edge left
    // the first four faces with a card hanging off to the right. The float's
    // window is the viewport and is sized to hold the card from the band's
    // edge (floatingRowSize), so there the floor is the viewport clamp.
    expect(cssVar(".face-card {", "--lead")).toBe("calc(var(--anchor) - var(--card-w) / 2 + var(--shift, 0px))");
    expect(cssVar('.face-card[data-density="float"] {', "--lead")).toBe("max(0px, calc(var(--anchor) - 8px - var(--card-w) / 2))");
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
    expect(mic).toContain("0 0 0 calc(var(--level) * 6px)");
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
    expect(cssVar('.engagement-card[data-density="float"] {', "background")).toBe("var(--sol-bg-alt)");
    expect(cssVar('.engagement-card[data-density="float"] {', "backdrop-filter")).toBe("none");
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
