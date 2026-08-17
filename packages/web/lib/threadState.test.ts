import { test, expect, describe } from "bun:test";
import { compactAge, threadStateView } from "./threadState";

const NOW = 1_700_000_000_000;

describe("compactAge", () => {
  test("reads compactly across the scale", () => {
    expect(compactAge(10_000)).toBe("just now");
    expect(compactAge(4 * 60_000)).toBe("4m");
    expect(compactAge(3 * 3_600_000)).toBe("3h");
    expect(compactAge(50 * 3_600_000)).toBe("2d");
  });
});

describe("threadStateView", () => {
  test("no state yields null", () => {
    expect(threadStateView(null, 10, NOW)).toBeNull();
    expect(threadStateView({ thread_state: "   " }, 10, NOW)).toBeNull();
  });

  test("headline and provenance for a fresh state", () => {
    const v = threadStateView(
      {
        thread_state: "Blocked: needs the prod key\nNext: deploy once it lands",
        thread_state_at: NOW - 4 * 60_000,
        thread_state_msg_count: 40,
      },
      43,
      NOW,
    )!;
    expect(v.headline).toBe("Blocked: needs the prod key");
    expect(v.freshness).toBe("fresh");
    expect(v.provenance).toBe("4m ago · 3 messages since");
  });

  test("a state written at the current message count shows only its age", () => {
    const v = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 60_000, thread_state_msg_count: 12 },
      12,
      NOW,
    )!;
    expect(v.provenance).toBe("1m ago");
    expect(v.messagesSince).toBe(0);
  });

  test("a far-behind state is hidden, not shown stale", () => {
    const v = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 60_000, thread_state_msg_count: 0 },
      400,
      NOW,
    );
    expect(v).toBeNull();
  });

  test("a state parked for days is hidden too", () => {
    const v = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 3 * 24 * 60 * 60_000, thread_state_msg_count: 0 },
      0,
      NOW,
    );
    expect(v).toBeNull();
  });

  test("a row with no write-time count claims no gap", () => {
    const v = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 60_000 },
      400,
      NOW,
    )!;
    expect(v.messagesSince).toBeNull();
    expect(v.provenance).toBe("1m ago");
  });
});
