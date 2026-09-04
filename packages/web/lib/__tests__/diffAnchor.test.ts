import { describe, expect, it } from "bun:test";
import {
  anchorEndLine,
  commentRangeEnd,
  diffLineKey,
  extendLineRange,
  isLineSelected,
  normalizeDiffSide,
  parseDiffLineKey,
} from "../patchParser";

describe("diff line keys", () => {
  it("round trips a single line and a run of lines", () => {
    expect(diffLineKey({ side: "RIGHT", lineNumber: 13 })).toBe("RIGHT:13");
    expect(diffLineKey({ side: "LEFT", lineNumber: 10, lineEnd: 13 })).toBe("LEFT:10-13");
    // A run of one is one line, so it keys the same as a bare line and joins
    // that thread instead of starting a second one beside it.
    expect(diffLineKey({ side: "RIGHT", lineNumber: 13, lineEnd: 13 })).toBe("RIGHT:13");

    expect(parseDiffLineKey("RIGHT:13")).toEqual({ side: "RIGHT", lineNumber: 13 });
    expect(parseDiffLineKey("LEFT:10-13")).toEqual({ side: "LEFT", lineNumber: 10, lineEnd: 13 });
    // An unknown side reads as the file after the change, same as a missing one.
    expect(parseDiffLineKey("SIDEWAYS:4").side).toBe("RIGHT");
  });

  it("hangs a thread under the last line it covers", () => {
    expect(anchorEndLine({ side: "RIGHT", lineNumber: 10, lineEnd: 13 })).toBe(13);
    expect(anchorEndLine({ side: "RIGHT", lineNumber: 10 })).toBe(10);
  });

  it("normalizes the side a comment names", () => {
    expect(normalizeDiffSide("LEFT")).toBe("LEFT");
    expect(normalizeDiffSide("left")).toBe("LEFT");
    expect(normalizeDiffSide(undefined)).toBe("RIGHT");
    expect(normalizeDiffSide("")).toBe("RIGHT");
  });
});

describe("selecting a run of lines", () => {
  it("anchors on where the selection started, in either direction", () => {
    expect(extendLineRange(null, 5)).toEqual({ start: 5, end: 5 });
    expect(extendLineRange({ start: 5, end: 5 }, 9)).toEqual({ start: 5, end: 9 });
    // Shift clicking back up the file keeps the original anchor, so the run
    // grows upward instead of collapsing.
    expect(extendLineRange({ start: 5, end: 9 }, 2)).toEqual({ start: 2, end: 5 });
  });

  it("knows which lines are in the selection", () => {
    const range = { start: 4, end: 7 };
    expect([3, 4, 6, 7, 8].map((n) => isLineSelected(range, n))).toEqual([false, true, true, true, false]);
    expect(isLineSelected(null, 4)).toBe(false);
  });

  it("gives a comment the selection's end only when the run is real and contains it", () => {
    expect(commentRangeEnd({ start: 4, end: 7 }, 5)).toBe(7);
    // Commenting outside the selection is about that line alone.
    expect(commentRangeEnd({ start: 4, end: 7 }, 9)).toBeUndefined();
    // A one line selection is not a run.
    expect(commentRangeEnd({ start: 4, end: 4 }, 4)).toBeUndefined();
    expect(commentRangeEnd(null, 4)).toBeUndefined();
  });
});
