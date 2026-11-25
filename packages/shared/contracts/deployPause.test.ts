import { describe, expect, test } from "bun:test";
import { inWorkingHours, reachedRollout, rollbackEnding } from "./deployPause";

// Pausing and rolling back production (deploys.md DP17 to DP19): what ends a rollback, when a cancel still stops a
// run, and when a pause may remind anyone. Synthetic data only.

describe("what ends a rollback", () => {
  test("a revert, unless a commit it took off carries a migration", () => {
    expect(rollbackEnding([{ files: ["api/a.ts"] }, { files: null }])).toEqual({ kind: "revert", migrations: [] });
    expect(rollbackEnding([{ files: ["outreach/backend/drizzle/0605_x.sql", "api/a.ts"] }, { files: ["db/migrations/7.sql"] }])).toEqual({
      kind: "fix_forward",
      migrations: ["outreach/backend/drizzle/0605_x.sql", "db/migrations/7.sql"],
    });
  });
});

describe("a run's rollout", () => {
  test("a run has reached rollout once its deploy or rollout job started; a skipped or waiting one has not", () => {
    expect(reachedRollout([{ name: "prepare", status: "completed", conclusion: "success" }, { name: "deploy", status: "queued" }])).toBe(false);
    expect(reachedRollout([{ name: "deploy", status: "completed", conclusion: "skipped" }])).toBe(false);
    expect(reachedRollout([{ name: "deploy", status: "in_progress" }])).toBe(true);
    expect(reachedRollout([{ name: "rollout web", status: "completed", conclusion: "failure" }])).toBe(true);
    expect(reachedRollout([{ name: "deploy-check", status: "in_progress" }])).toBe(false);
  });
});

describe("working hours", () => {
  test("weekdays 9:00 to 18:00 in the team's zone", () => {
    const zone = "America/Los_Angeles";
    expect(inWorkingHours(Date.parse("2026-11-25T17:00:00Z"), zone)).toBe(true);
    expect(inWorkingHours(Date.parse("2026-11-25T16:59:00Z"), zone)).toBe(false);
    expect(inWorkingHours(Date.parse("2026-11-26T02:00:00Z"), zone)).toBe(false);
    expect(inWorkingHours(Date.parse("2026-11-28T20:00:00Z"), zone)).toBe(false);
  });
});
