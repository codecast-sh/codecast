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
import { FACE_ROW_METRICS, LINK_PULL, faceRowSize, faceRowWidth } from "../FaceRow";

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
  test("the pull", () => {
    expect(cssVar(".face-link {", "margin")).toBe(`0 calc(var(--face-gap) * -${LINK_PULL})`);
  });
  test("the card hangs from the bar and sits under the float", () => {
    expect(cssVar('.engagement-card[data-density="bar"] {', "position")).toBe("absolute");
    expect(cssVar('.engagement-card[data-density="float"] {', "position")).toBe("relative");
  });
});
