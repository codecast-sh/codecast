import { describe, expect, test } from "bun:test";
import { looseGate } from "./orgLooseRun";

// The daily look's precheck (org-staffing.md S43): it runs the Head of
// People only when a loose session is new since its last look.
describe("cast org loose --new", () => {
  const answer = (fresh: string[]) => ({ count: 3, rows: [], last_look_at: 1, new: fresh });
  test("passes when something is new", () => expect(looseGate(answer(["jx7aaaa"]))).toEqual({ code: 0, line: "1 new loose session" }));
  test("skips when nothing is new, or there is no org to read", () => {
    expect(looseGate(answer([])).code).toBe(1);
    expect(looseGate(null).code).toBe(1);
  });
});
