import { describe, expect, test } from "bun:test";
import { graphChange, graphChangeText } from "./index";

// `cast task show`'s History reads a graph change in the timeline's words
// (task-graph.md TG11), never "field: old to new" with an empty side.
describe("a graph change as a history line", () => {
  const line = (field: string, old_value: string, new_value: string) => graphChangeText(graphChange({ field, old_value, new_value })!);

  test("waits read as what happened to them", () => {
    expect(line("waits", "", "Waiting on PR #51")).toBe("made it wait on PR #51");
    expect(line("waits", "", "Wait on PR #51, already merged")).toBe("made it wait on PR #51, already merged");
    expect(line("waits", "Waiting until Oct 11, 2026 09:20 UTC", "")).toBe("stopped waiting until Oct 11, 2026 09:20 UTC");
    expect(line("waits", "Waiting on PR #51", "PR #51 merged")).toBe("saw the wait met: PR #51 merged");
    expect(line("waits", "Waiting on PR #6", "Wait on PR #6 failed: closed without merging")).toBe("marked the wait on PR #6 failed: closed without merging");
    expect(line("waits", "Wait on PR #6 failed: closed without merging", "")).toBe("removed the wait on PR #6");
    expect(line("waits", "sd-4 answered", "Waiting on sd-4")).toBe("reopened the wait on sd-4");
  });

  test("lines stored before the clause was kept still read", () => {
    expect(line("waits", "", "PR #51 merged")).toBe("made it wait, already met: PR #51 merged");
    expect(line("waits", "Waiting on PR #6", "PR #6 merges (failed: closed without merging)")).toBe("marked the wait failed: PR #6 merges (failed: closed without merging)");
  });

  test("links name the tasks", () => {
    expect(line("found_during", "", "ct-58089")).toBe("found it while working on ct-58089");
    expect(line("related", "", "ct-58206")).toBe("marked it related to ct-58206");
    expect(line("related", "ct-58206", "")).toBe("unmarked related ct-58206");
    expect(line("blocked_by", "ct-1", "ct-2")).toBe("made it wait on ct-2 and removed ct-1");
  });

  // A removal withdraws an edge; it does not say the work behind it got done,
  // so a timeline may not draw it with the green check a met wait earns.
  test("a removal is withdrawn, a wait genuinely met is met", () => {
    const tone = (field: string, old_value: string, new_value: string) => graphChange({ field, old_value, new_value })!.tone;
    expect(tone("blocked_by", "ct-12", "")).toBe("withdrawn");
    expect(tone("blocked_by", "", "ct-12")).toBe("blocked");
    expect(tone("waits", "Waiting on PR #42", "")).toBe("withdrawn");
    expect(tone("waits", "PR #42 merged", "")).toBe("withdrawn");
    expect(tone("waits", "Waiting on PR #42", "PR #42 merged")).toBe("met");
  });

  test("any other field is not a graph change", () => {
    expect(graphChange({ field: "priority", old_value: "low", new_value: "high" })).toBeNull();
  });
});
