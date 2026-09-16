import { describe, expect, test } from "bun:test";
import { groupTurns, oneSegmentTurns, type TranscriptSegment } from "./transcriptTurnModel";

const seg = (
  over: Partial<TranscriptSegment> & Pick<TranscriptSegment, "seq" | "text">,
): TranscriptSegment => ({
  speaker_id: "mic",
  speaker_name: "Speaker",
  t0: over.seq * 1000,
  ...over,
});

describe("groupTurns", () => {
  test("consecutive lines from one speaker fold into one turn", () => {
    const turns = groupTurns([
      seg({ seq: 1, text: "one" }),
      seg({ seq: 2, text: "two" }),
      seg({ seq: 3, speaker_id: "them", speaker_name: "Sam", text: "three" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.segments.map((s) => s.text)).toEqual(["one", "two"]);
    expect(turns[1]!.segments.map((s) => s.text)).toEqual(["three"]);
  });
});

describe("oneSegmentTurns", () => {
  test("a recording does not fold the whole meeting into one block", () => {
    const turns = oneSegmentTurns([
      seg({ seq: 1, text: "one" }),
      seg({ seq: 2, text: "two" }),
      seg({ seq: 3, text: "three" }),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.segments.map((s) => s.text))).toEqual([["one"], ["two"], ["three"]]);
    expect(turns.map((t) => t.t0)).toEqual([1000, 2000, 3000]);
  });
});
