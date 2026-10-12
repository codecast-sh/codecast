import { describe, expect, test } from "bun:test";
import { addMove, emptyTally, formatMoveTally, parseMoveTally } from "./moveTally";

describe("move tally", () => {
  test("a run's moves fold into one note with a count per problem", () => {
    let text = formatMoveTally(addMove(emptyTally(), "out", "ct-2", 1, false));
    for (const [dir, other, fresh] of [["out", "ct-2", false], ["out", "ct-9", true], ["in", "ct-4", false], ["out", "ct-2", false]] as const) {
      text = formatMoveTally(addMove(parseMoveTally(text)!, dir, other, 1, fresh));
    }
    expect(text).toBe("Reports moved: 1 in, 4 out\nIn: 1 from ct-4\nOut: 3 to ct-2, 1 to ct-9 (new)");
  });
  test("other comments are not move notes", () => {
    expect(parseMoveTally("Took 1 report (moment:mo-247) from ct-59385.")).toBeNull();
  });
});
