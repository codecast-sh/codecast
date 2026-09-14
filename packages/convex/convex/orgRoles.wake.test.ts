import { describe, expect, test } from "bun:test";
import { wakeIsHeld } from "./orgRoles";

// A wake on a paused role lands in the outbox and stays there until someone
// resumes it (orgWakes gate 1). performWakeRole reports that as `held` so the
// web toast can say "queued" instead of "woke".
describe("wakeIsHeld", () => {
  test("a paused role holds the line", () => {
    expect(wakeIsHeld({ status: "paused" })).toBe(true);
  });
  test("an active role wakes now", () => {
    expect(wakeIsHeld({ status: "active" })).toBe(false);
  });
});
