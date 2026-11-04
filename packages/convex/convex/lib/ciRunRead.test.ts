import { describe, expect, test } from "bun:test";
import { CI_LOG_LINES, logTail, readAnnotations, readJobs, readRun } from "./ciRunRead";

describe("readRun", () => {
  test("title, actor, attempt and duration", () => {
    const r = readRun({ display_title: "fix: tests", event: "push", run_attempt: 2, triggering_actor: { login: "ada" }, run_started_at: "2026-11-03T10:00:00Z", updated_at: "2026-11-03T10:07:30Z" });
    expect(r).toEqual({ title: "fix: tests", event: "push", actor: "ada", attempt: 2, started_at: Date.parse("2026-11-03T10:00:00Z"), duration_ms: 450_000 });
  });
});

describe("readJobs", () => {
  test("failed jobs lead, with their steps", () => {
    const jobs = readJobs({
      jobs: [
        { id: 1, name: "lint", conclusion: "success", steps: [] },
        { id: 2, name: "e2e", conclusion: "failure", started_at: "2026-11-03T10:00:00Z", completed_at: "2026-11-03T10:01:00Z", steps: [{ number: 1, name: "checkout", conclusion: "success" }, { number: 4, name: "run tests", conclusion: "failure" }] },
      ],
    });
    expect(jobs.map((j) => j.name)).toEqual(["e2e", "lint"]);
    expect(jobs[0].duration_ms).toBe(60_000);
    expect(jobs[0].steps[1]).toEqual({ number: 4, name: "run tests", conclusion: "failure" });
  });
});

describe("readAnnotations", () => {
  test("drops notices", () => {
    const a = readAnnotations("e2e", [
      { annotation_level: "notice", message: "cache hit" },
      { annotation_level: "failure", message: "expected 2 got 3", path: "a.test.ts", start_line: 12, title: "a > b" },
    ]);
    expect(a).toEqual([{ job: "e2e", level: "failure", message: "expected 2 got 3", path: "a.test.ts", line: 12, title: "a > b" }]);
  });
});

describe("logTail", () => {
  test("ends at the last error, without timestamps, groups or colour", () => {
    const lines = [
      "2026-11-03T10:00:00.0000000Z ##[group]Run tests",
      "2026-11-03T10:00:01.0000000Z \u001b[31mFAIL\u001b[0m a.test.ts",
      "2026-11-03T10:00:02.0000000Z ##[endgroup]",
      "2026-11-03T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
      "2026-11-03T10:00:04.0000000Z after 1",
      "2026-11-03T10:00:05.0000000Z after 2",
      "2026-11-03T10:00:06.0000000Z after 3",
      "2026-11-03T10:00:07.0000000Z Post job cleanup.",
      "2026-11-03T10:00:08.0000000Z more cleanup",
    ];
    expect(logTail(lines.join("\n"))).toBe(["FAIL a.test.ts", "##[error]Process completed with exit code 1."].join("\n"));
  });

  test("a log with no error keeps its last lines", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const tail = logTail(text).split("\n");
    expect(tail.length).toBe(CI_LOG_LINES);
    expect(tail[tail.length - 1]).toBe("line 199");
  });
});
