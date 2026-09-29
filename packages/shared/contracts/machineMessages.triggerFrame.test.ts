import { describe, expect, test } from "bun:test";
import { formatScheduledTask, parseScheduledTask, type ScheduledTaskFrame } from "./machineMessages";

describe("the trigger run frame", () => {
  test("a role's run carries its card and the waiting session, and reads back whole", () => {
    const frame: ScheduledTaskFrame = {
      title: "A session under you needs input", task_id: "t1", trigger: "tr-9", event: "session_needs_input",
      role: { handle: "calling", name: "Calling lead", reports_to: "Cam", scope: ["Callers & Call Management", "camerons ideas"], charter: "Keeps the caller team effective.", goals: ["Cost per intro under $250"] },
      waiting: { short_id: "jx7hand", title: "Fix the parser", why: "blocked", since: 5, state: "Which price band?" },
      body: "A session that reports to you is waiting.",
    };
    const text = formatScheduledTask(frame);
    expect(text).toContain("Looks after: Callers & Call Management, camerons ideas");
    expect(parseScheduledTask(text)).toEqual(frame);
  });

  test("a role with no scope is told it runs its routine; a run with no role has no card", () => {
    const text = formatScheduledTask({ title: "Check X's area", role: { handle: "x", name: "X", reports_to: "Ada", scope: [], goals: [] }, body: "Check." });
    expect(text).toContain("Looks after no area of its own");
    expect(parseScheduledTask(text)?.role).toEqual({ handle: "x", name: "X", reports_to: "Ada", scope: [], goals: [] });
    expect(parseScheduledTask(formatScheduledTask({ title: "T", body: "B" }))?.role).toBeNull();
  });
});
