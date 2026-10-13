import { describe, expect, test } from "bun:test";
import { shouldShowSession } from "../sessionFilters";

// Rows already cached on a client (the inbox cache the feed merges in) pass the
// same rule the server lists apply: a workflow run's own log never shows.
describe("shouldShowSession and run logs", () => {
  const base = { title: "line", message_count: 4 };
  test("a run's own log is hidden", () => {
    expect(shouldShowSession({ ...base, is_workflow_primary: true, workflow_run_id: "run1" })).toBe(false);
  });
  test("a session hosting a run is shown", () => {
    expect(shouldShowSession({ ...base, workflow_run_id: "run1" })).toBe(true);
  });
});
