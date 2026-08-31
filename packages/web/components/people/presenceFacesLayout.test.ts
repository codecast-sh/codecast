import { describe, expect, it } from "bun:test";
import {
  CHROME_WIDTH,
  FACES_PADDING,
  FACE_GAP,
  HOVER_ROWS,
} from "../../lib/calls/faceCrop";
import { buildWall, type Wall } from "./peopleWallLayout";
import {
  MAX_OVERLAY_FACES,
  OVERLAY_FACE_PX,
  overlayFaces,
  overlayWindowSize,
} from "./presenceFacesLayout";

// A wall shaped by hand: N present faces and M gone ones, ids in order.
function wallOf(present: number, gone: number): Wall<{ id: string }> {
  const mk = (i: number, tier: "here" | "gone") => ({ id: `${tier}${i}` });
  return buildWall(
    [
      ...Array.from({ length: present }, (_, i) => mk(i, "here")),
      ...Array.from({ length: gone }, (_, i) => mk(i, "gone")),
    ],
    (m) => (m.id.startsWith("gone") ? "offline" : "active"),
    () => null,
    (m) => m.id,
    (m) => m.id,
    OVERLAY_FACE_PX,
  );
}

describe("overlayFaces", () => {
  it("floats the present and leaves the offline folded", () => {
    const { shown, overflow } = overlayFaces(wallOf(3, 5), false);
    expect(shown.map((f) => f.id)).toEqual(["here0", "here1", "here2"]);
    expect(overflow).toBe(0);
  });

  it("everyone folds the offline in after the present", () => {
    const { shown, overflow } = overlayFaces(wallOf(2, 2), true);
    expect(shown.map((f) => f.id)).toEqual(["here0", "here1", "gone0", "gone1"]);
    expect(overflow).toBe(0);
  });

  it("caps the row and counts the rest", () => {
    const { shown, overflow } = overlayFaces(wallOf(MAX_OVERLAY_FACES + 4, 0), false);
    expect(shown.length).toBe(MAX_OVERLAY_FACES);
    expect(overflow).toBe(4);
  });

  it("keeps the wall's own order — presence first, biggest first", () => {
    const wall = buildWall(
      [{ id: "quiet" }, { id: "busy" }],
      (m) => "active" as const,
      (m) => (m.id === "busy" ? ({ working: 1, needsYou: 0 } as any) : null),
      (m) => m.id,
      (m) => m.id,
      OVERLAY_FACE_PX,
    );
    const { shown } = overlayFaces(wall, false);
    expect(shown.map((f) => f.id)).toEqual(["busy", "quiet"]);
    expect(shown[0].px).toBe(OVERLAY_FACE_PX.loud);
    expect(shown[1].px).toBe(OVERLAY_FACE_PX.here);
  });
});

describe("overlayWindowSize", () => {
  it("is the circles, their gaps and the ring padding — nothing else", () => {
    const size = overlayWindowSize([56, 44, 34]);
    expect(size.width).toBe(56 + 44 + 34 + 2 * FACE_GAP + 2 * FACES_PADDING);
    expect(size.height).toBe(56 + 2 * FACES_PADDING);
  });

  it("hovering adds the slot and the chrome below the circles", () => {
    const rest = overlayWindowSize([44]);
    const hovered = overlayWindowSize([44], { hovered: true });
    expect(hovered.height).toBe(rest.height + HOVER_ROWS);
  });

  it("hovering never lets the chrome clip: one small face widens to the chrome", () => {
    const hovered = overlayWindowSize([28], { hovered: true });
    expect(hovered.width).toBe(CHROME_WIDTH + 2 * FACES_PADDING);
  });

  it("an empty row still has a window — the empty state draws one face", () => {
    const size = overlayWindowSize([]);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});
