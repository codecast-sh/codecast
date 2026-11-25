import { describe, expect, test } from "bun:test";
import { briefReportLines } from "./briefLines";
import { stripAnsi } from "@platform/cli-kit/render";

// `cast brief`: the people who report to the role (org-people.md P2), each
// with what of the area waits on them and the ids the check asks about.

describe("briefReportLines", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  test("each person's line, their waits, then the decisions and tasks by id", () => {
    const lines = briefReportLines([
      {
        line: "Dana @dana · Designer",
        waits: { decisions_over_day: 1, open_tasks: 1, review_over_day: 1 },
        decisions: [{ short_id: "sd-9", question: "Which pricing page?", created_at: now - 2 * 86_400_000 }],
        tasks: [{ short_id: "ct-4", title: "Ship onboarding", status: "in_review", updated_at: now - 2 * 86_400_000 }],
      },
      { line: "Lee @lee", waits: { decisions_over_day: 0, open_tasks: 0, review_over_day: 0 }, decisions: [], tasks: [] },
    ], now).map(stripAnsi);
    expect(lines[0]).toBe("  people who report to it:");
    expect(lines[1]).toBe("    Dana @dana · Designer · 1 decision waiting over a day, 1 task in review over a day, 1 open task");
    expect(lines[2]).toMatch(/^      sd-9 Which pricing page\? · asked /);
    expect(lines[3]).toBe("      ct-4 Ship onboarding · in_review");
    expect(lines[4]).toBe("    Lee @lee · nothing waits on them");
  });

  test("nobody reporting prints nothing", () => {
    expect(briefReportLines([], now)).toEqual([]);
  });
});
