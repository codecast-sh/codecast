import { describe, test, expect } from "bun:test";
import {
  normalizeThreadState,
  threadStateHeadline,
  threadStateFreshness,
  hasThreadState,
  THREAD_STATE_MAX_CHARS,
  THREAD_STATE_AGING_MSGS,
  THREAD_STATE_STALE_MSGS,
  THREAD_STATE_STALE_MS,
} from "./threadState";

describe("normalizeThreadState", () => {
  test("trims and collapses blank-line runs", () => {
    expect(normalizeThreadState("  Status: waiting\n\n\n\nNext: ship it  ")).toBe(
      "Status: waiting\n\nNext: ship it",
    );
  });

  test("keeps single blank lines and strips trailing spaces per line", () => {
    expect(normalizeThreadState("a   \n\nb")).toBe("a\n\nb");
  });

  test("drops shared indentation but keeps nesting", () => {
    expect(normalizeThreadState("    Status: green\n      - detail\n    Next: ship")).toBe(
      "Status: green\n  - detail\nNext: ship",
    );
  });

  test("normalizes CRLF", () => {
    expect(normalizeThreadState("a\r\nb")).toBe("a\nb");
  });

  test("empty once trimmed reads as a clear", () => {
    expect(normalizeThreadState("   \n \n ")).toBe("");
  });

  test("caps overlong text with an ellipsis", () => {
    const out = normalizeThreadState("x".repeat(THREAD_STATE_MAX_CHARS + 500));
    expect(out.length).toBe(THREAD_STATE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("threadStateHeadline", () => {
  test("takes the first non-empty line", () => {
    expect(threadStateHeadline("\n\nWaiting on CI\nNext: merge")).toBe("Waiting on CI");
  });

  test("drops a leading bullet", () => {
    expect(threadStateHeadline("- Waiting on CI")).toBe("Waiting on CI");
  });

  test("drops a redundant Status label but keeps other labels", () => {
    expect(threadStateHeadline("Status: waiting on CI")).toBe("waiting on CI");
    expect(threadStateHeadline("Blocked: needs a key")).toBe("Blocked: needs a key");
  });

  test("empty text yields empty headline", () => {
    expect(threadStateHeadline("   ")).toBe("");
  });
});

describe("threadStateFreshness", () => {
  const now = 1_000_000_000;

  test("a state written a few messages ago is fresh", () => {
    const r = threadStateFreshness(
      { thread_state_at: now - 60_000, thread_state_msg_count: 100 },
      104,
      now,
    );
    expect(r.freshness).toBe("fresh");
    expect(r.messagesSince).toBe(4);
    expect(r.ageMs).toBe(60_000);
  });

  test("crossing the aging threshold dims it", () => {
    const r = threadStateFreshness(
      { thread_state_at: now, thread_state_msg_count: 0 },
      THREAD_STATE_AGING_MSGS,
      now,
    );
    expect(r.freshness).toBe("aging");
  });

  test("crossing the stale message threshold marks it stale", () => {
    const r = threadStateFreshness(
      { thread_state_at: now, thread_state_msg_count: 0 },
      THREAD_STATE_STALE_MSGS,
      now,
    );
    expect(r.freshness).toBe("stale");
  });

  test("a busy agent turn does not by itself age a just-written state", () => {
    const r = threadStateFreshness(
      { thread_state_at: now - 3 * 60_000, thread_state_msg_count: 100 },
      140,
      now,
    );
    expect(r.freshness).toBe("fresh");
  });

  test("age alone can make it stale in a quiet thread", () => {
    const r = threadStateFreshness(
      { thread_state_at: now - THREAD_STATE_STALE_MS, thread_state_msg_count: 10 },
      10,
      now,
    );
    expect(r.freshness).toBe("stale");
    expect(r.messagesSince).toBe(0);
  });

  test("a missing stored count yields null rather than a false zero", () => {
    const r = threadStateFreshness({ thread_state_at: now - 1000 }, 500, now);
    expect(r.messagesSince).toBeNull();
    expect(r.freshness).toBe("fresh");
  });

  test("a shrinking message count never goes negative", () => {
    const r = threadStateFreshness(
      { thread_state_at: now, thread_state_msg_count: 100 },
      40,
      now,
    );
    expect(r.messagesSince).toBe(0);
  });
});

describe("hasThreadState", () => {
  test("blank or absent text is no state", () => {
    expect(hasThreadState(null)).toBe(false);
    expect(hasThreadState({})).toBe(false);
    expect(hasThreadState({ thread_state: "   " })).toBe(false);
    expect(hasThreadState({ thread_state: "up" })).toBe(true);
  });
});
