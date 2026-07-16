import { test, expect, describe } from "bun:test";
import { parseScheduleCadence, humanizeDurationToken, describeTaskCadence, isTaskOverdue, taskStateLabel } from "./scheduleCadence";

describe("humanizeDurationToken", () => {
  test("expands unit abbreviations to words", () => {
    expect(humanizeDurationToken("8h")).toBe("8 hours");
    expect(humanizeDurationToken("30m")).toBe("30 minutes");
    expect(humanizeDurationToken("10s")).toBe("10 seconds");
    expect(humanizeDurationToken("3d")).toBe("3 days");
  });

  test("singular when count is 1", () => {
    expect(humanizeDurationToken("1h")).toBe("1 hour");
    expect(humanizeDurationToken("1d")).toBe("1 day");
    expect(humanizeDurationToken("1m")).toBe("1 minute");
  });

  test("accepts long-form and spaced units", () => {
    expect(humanizeDurationToken("2hr")).toBe("2 hours");
    expect(humanizeDurationToken("1hour")).toBe("1 hour");
    expect(humanizeDurationToken("90min")).toBe("90 minutes");
    expect(humanizeDurationToken("4 days")).toBe("4 days");
  });

  test("falls back to the raw token when unrecognized", () => {
    expect(humanizeDurationToken("soon")).toBe("soon");
    expect(humanizeDurationToken("")).toBe("");
  });
});

describe("parseScheduleCadence", () => {
  test("--every renders a recurring cadence", () => {
    expect(parseScheduleCadence('"do the thing" --every 8h')).toBe("every 8 hours");
    expect(parseScheduleCadence('"x" --every 4h')).toBe("every 4 hours");
    expect(parseScheduleCadence('"x" --every 1d')).toBe("every 1 day");
  });

  test("--in renders a one-shot delay", () => {
    expect(parseScheduleCadence('"x" --in 30m')).toBe("in 30 minutes");
    expect(parseScheduleCadence('"x" --in 2h')).toBe("in 2 hours");
  });

  test("--on renders an event trigger with a friendly label", () => {
    expect(parseScheduleCadence('"x" --on pr_comment')).toBe("on PR comment");
    expect(parseScheduleCadence('"x" --on pr_opened')).toBe("on PR opened");
    expect(parseScheduleCadence('"x" --on pr_merged')).toBe("on PR merged");
    expect(parseScheduleCadence('"x" --on push')).toBe("on push");
  });

  test("unknown event falls back to a de-underscored label", () => {
    expect(parseScheduleCadence('"x" --on issue_opened')).toBe("on issue opened");
  });

  test("no timing flag means it runs now", () => {
    expect(parseScheduleCadence('"just do it"')).toBe("now");
    expect(parseScheduleCadence('"just do it" --mode apply --context current')).toBe("now");
  });

  test("--every wins when multiple timing flags are present", () => {
    expect(parseScheduleCadence('"x" --every 8h --in 30m')).toBe("every 8 hours");
  });

  test("accepts the --flag=value form", () => {
    expect(parseScheduleCadence('"x" --every=12h')).toBe("every 12 hours");
  });

  test("ignores flag-like text inside the quoted prompt", () => {
    // The prompt mentions a non-duration value after --in, so it is not treated as a cadence.
    expect(parseScheduleCadence('"summarize the PR in detail"')).toBe("now");
    expect(parseScheduleCadence('"review --in depth please"')).toBe("now");
  });

  test("real-world args with a long prompt and trailing flags", () => {
    const args = '"Review open PRs and summarize findings for ct-33494" --every 4h --mode apply --project /Users/ashot/src/codecast';
    expect(parseScheduleCadence(args)).toBe("every 4 hours");
  });
});

describe("describeTaskCadence", () => {
  test("recurring uses the compact interval", () => {
    expect(describeTaskCadence({ schedule_type: "recurring", interval_ms: 8 * 3600_000 })).toBe("every 8h");
    expect(describeTaskCadence({ schedule_type: "recurring", interval_ms: 150 * 60_000 })).toBe("every 2h 30m");
    expect(describeTaskCadence({ schedule_type: "recurring", interval_ms: 90_000 })).toBe("every 2m");
  });

  test("event uses the friendly trigger label", () => {
    expect(describeTaskCadence({ schedule_type: "event", event_filter: { event_type: "pr_comment" } })).toBe("on PR comment");
    expect(describeTaskCadence({ schedule_type: "event", event_filter: { event_type: "issue_opened" } })).toBe("on issue opened");
    expect(describeTaskCadence({ schedule_type: "event" })).toBe("on event");
  });

  test("once reads as one-time", () => {
    expect(describeTaskCadence({ schedule_type: "once" })).toBe("one-time");
    // recurring without an interval (malformed row) degrades to one-time, not a crash
    expect(describeTaskCadence({ schedule_type: "recurring" })).toBe("one-time");
  });
});

describe("taskStateLabel", () => {
  const now = 1_000_000_000;

  test("future fire reads as a sentence: in <time>", () => {
    expect(taskStateLabel({ status: "scheduled", run_at: now + 2 * 3600_000 + 6 * 60_000 }, now)).toBe("in 2h 6m");
    expect(taskStateLabel({ status: "scheduled", run_at: now + 45_000 }, now)).toBe("in 45s");
  });

  test("elapsed fire is due", () => {
    expect(taskStateLabel({ status: "scheduled", run_at: now - 1 }, now)).toBe("due");
  });

  test("stuck past the overdue threshold says how stuck", () => {
    expect(taskStateLabel({ status: "scheduled", run_at: now - 2 * 60_000 }, now)).toBe("due 2m");
    expect(taskStateLabel({ status: "scheduled", run_at: now - 90_000 }, now)).toBe("due");
    expect(isTaskOverdue({ status: "scheduled", run_at: now - 2 * 60_000 }, now)).toBe(true);
    expect(isTaskOverdue({ status: "scheduled", run_at: now - 90_000 }, now)).toBe(false);
    expect(isTaskOverdue({ status: "paused", run_at: now - 10 * 60_000 }, now)).toBe(false);
  });

  test("state words win over the clock", () => {
    expect(taskStateLabel({ status: "paused", run_at: now + 60_000 }, now)).toBe("paused");
    expect(taskStateLabel({ status: "running", run_at: now + 60_000 }, now)).toBe("running");
  });

  test("no timed fire means event", () => {
    expect(taskStateLabel({ status: "scheduled" }, now)).toBe("event");
  });
});
