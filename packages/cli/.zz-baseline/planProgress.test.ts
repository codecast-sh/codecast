import { describe, expect, test } from "bun:test";
import { planProgressLabel } from "./planProgress";

describe("planProgressLabel", () => {
  test("counts the tasks the payload lists", () => {
    expect(planProgressLabel({ tasks: [{ status: "done" }, { status: "open" }, { status: "done" }] })).toBe("2/3 tasks done");
    expect(planProgressLabel({ tasks: [] })).toBe("no tasks");
  });
  test("falls back to a tally when no tasks ride along", () => {
    expect(planProgressLabel({ task_total: 4, task_done: 1 })).toBe("1/4 tasks done");
    expect(planProgressLabel({})).toBe("no tasks");
  });
});
