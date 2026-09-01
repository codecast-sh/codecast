import { describe, expect, test } from "bun:test";
import { isArmedLoopHome } from "./dormancy";
import { LOOP_OVERDUE_GRACE_MS } from "@codecast/shared/contracts";

const now = 1_788_200_000_000;
const armed = { status: "armed", wakeup_at: now + 60_000, armed_at: now - 60_000, event_at: now - 60_000 };

describe("isArmedLoopHome", () => {
  test("a fresh armed wakeup parks the home", () => {
    expect(isArmedLoopHome({ loop_state: armed }, now)).toBe(true);
  });

  test("machine-delivered last turn keeps the park; a human turn breaks it", () => {
    expect(isArmedLoopHome({ loop_state: armed, last_message_preview: "<task-notification>…" }, now)).toBe(true);
    expect(isArmedLoopHome({ loop_state: armed, last_message_preview: "hey can you check this" }, now)).toBe(false);
  });

  test("an overdue wakeup is a dead harness — no park", () => {
    const overdue = { ...armed, wakeup_at: now - LOOP_OVERDUE_GRACE_MS - 1 };
    expect(isArmedLoopHome({ loop_state: overdue }, now)).toBe(false);
  });

  test("waking and stopped never park (the active arms own waking)", () => {
    expect(isArmedLoopHome({ loop_state: { ...armed, status: "waking", fired_at: now } }, now)).toBe(false);
    expect(isArmedLoopHome({ loop_state: { ...armed, status: "stopped" } }, now)).toBe(false);
    expect(isArmedLoopHome({}, now)).toBe(false);
  });
});
