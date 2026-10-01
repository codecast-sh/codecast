// A dynamic workflow's snapshot speaks the runtime's vocabulary. A stopped run
// arrives as "killed"; mapping an unknown word to "running" kept every stopped
// run's row (and its host card's "waiting on the fleet" bar) live forever.
import { expect, test } from "bun:test";
import { ingestRunStatus } from "./workflow_runs";

test("live and finished statuses pass through", () => {
  for (const s of ["pending", "running", "paused", "completed", "failed"] as const) expect(ingestRunStatus(s)).toBe(s);
});

test("a stopped or unknown status is over, never running", () => {
  expect(ingestRunStatus("killed")).toBe("failed");
  expect(ingestRunStatus("cancelled")).toBe("failed");
  expect(ingestRunStatus("")).toBe("failed");
});
