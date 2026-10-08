import { describe, expect, test } from "bun:test";
import { graphChange, graphChangeText } from "./index";

// `cast task show`'s History reads a graph change in the timeline's words
// (task-graph.md TG11), never "field: old to new" with an empty side.
describe("a graph change as a history line", () => {
  const line = (field: string, old_value: string, new_value: string) => graphChangeText(graphChange({ field, old_value, new_value })!);

  test("waits read as what happened to them", () => {
    expect(line("waits", "", "Waiting on PR #51")).toBe("made it wait on PR #51");
    expect(line("waits", "", "PR #51 merged")).toBe("set a wait, already met: PR #51 merged");
    expect(line("waits", "Waiting until Oct 11, 2026 09:20 UTC", "")).toBe("stopped waiting until Oct 11, 2026 09:20 UTC");
    expect(line("waits", "Waiting on PR #51", "PR #51 merged")).toBe("wait met: PR #51 merged");
  });

  test("links name the tasks", () => {
    expect(line("found_during", "", "ct-58089")).toBe("found it while working on ct-58089");
    expect(line("related", "", "ct-58206")).toBe("linked it to ct-58206");
    expect(line("blocked_by", "ct-1", "ct-2")).toBe("made it wait on ct-2 and removed ct-1");
  });

  test("any other field is not a graph change", () => {
    expect(graphChange({ field: "priority", old_value: "low", new_value: "high" })).toBeNull();
  });
});
