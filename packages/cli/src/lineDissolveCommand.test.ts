import { describe, expect, test } from "bun:test";
import { dissolveClose, namedChange } from "./lineDissolveCommand";

describe("dissolve close", () => {
  test("the judge was wrong: dropped", () => {
    expect(dissolveClose("judge_defect", "", "Union waited as asked.", null)).toEqual({ outcome: "dropped", note: "Dropped: the judge was wrong. Union waited as asked." });
  });
  test("another problem holds it: merged into that problem", () => {
    expect(dissolveClose("known_cause", "ct-59434", "same opener", null)).toMatchObject({ outcome: "merged", into: "ct-59434" });
    expect(dissolveClose("known_cause", "", "same", null)).toHaveProperty("error");
  });
  test("a fix in flight waits on its task; with no task the problem stays open", () => {
    expect(dissolveClose("in_flight", "ct-57467", "unmerged fix", false)).toMatchObject({ outcome: "waiting", into: "ct-57467" });
    expect(dissolveClose("in_flight", "", "a branch somewhere", null)).toHaveProperty("error");
    expect(dissolveClose("in_flight", "ct-57467", "landed since", true)).toMatchObject({ outcome: "done" });
  });
  test("fixed by a change that has not landed waits on the task its words name (ct-59338)", () => {
    const note = "ct-57467 (In Review) already owns this exact block: its unmerged fix 85cf4bc4c7 on origin/codecast/agentwatch-ct-57467 rewrites it";
    expect(namedChange(note)).toBe("origin/codecast/agentwatch-ct-57467");
    expect(dissolveClose("already_fixed", "85cf4bc4c7", note, false)).toMatchObject({ outcome: "waiting", into: "ct-57467" });
    expect(dissolveClose("already_fixed", "abc1234", "fixed Oct 6", true)).toMatchObject({ outcome: "done" });
  });
  test("a station that reported no kind closes done, as before", () => {
    expect(dissolveClose(".json.kind", ".json.into", "Dissolved before investigation.", null)).toMatchObject({ outcome: "done" });
  });
});
