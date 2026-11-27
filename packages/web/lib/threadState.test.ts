import { test, expect, describe } from "bun:test";
import { compactAge, declaredOfPlacement, declaredOfWorkState, threadStateView } from "./threadState";

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

  test("the header stamp is just the age while fresh, the gap only once aging", () => {
    const fresh = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 60 * 60_000, thread_state_msg_count: 40 },
      45,
      NOW,
    )!;
    expect(fresh.stamp).toBe("1h");
    const aging = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 4 * 3_600_000, thread_state_msg_count: 0 },
      64,
      NOW,
    )!;
    expect(aging.freshness).toBe("aging");
    expect(aging.stamp).toBe("4h · 64 new messages");
    const quiet = threadStateView(
      { thread_state: "Waiting on CI", thread_state_at: NOW - 15 * 3_600_000, thread_state_msg_count: 10 },
      12,
      NOW,
    )!;
    expect(quiet.freshness).toBe("aging");
    expect(quiet.stamp).toBe("15h");
  });

  test("rows and the card line come from the shared parser", () => {
    const v = threadStateView(
      {
        thread_state: "Release is waiting on a signing key\nYou: add it to the repo secrets\nDone: build green",
        thread_state_at: NOW - 60_000,
        thread_state_msg_count: 3,
      },
      3,
      NOW,
    )!;
    expect(v.rows.map((r) => r.label)).toEqual(["You", "Done"]);
    expect(v.cardLine).toBe("add it to the repo secrets");
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

// The inbox owns who acts next. A surface that knows where the row files
// passes it, and a pin claim the placement overrules shows no status: jx75e8s
// sat under Needs You wearing "Dormant" after a wake turn left its pin stale.
describe("threadStateView: the placement overrules the declared status", () => {
  const pin = (status: string) => ({
    thread_state: "Waiting on typecheck",
    thread_state_at: NOW - 4 * 60_000,
    thread_state_msg_count: 160,
    thread_state_status: status,
  });

  test("a status the placement agrees with stands", () => {
    expect(threadStateView(pin("dormant"), 165, NOW, "dormant")!.status).toBe("dormant");
    expect(threadStateView(pin("blocked"), 165, NOW, "blocked")!.status).toBe("blocked");
  });

  test("a status the placement files elsewhere shows none, and the line stays", () => {
    const v = threadStateView(pin("dormant"), 165, NOW, "blocked")!;
    expect(v.status).toBeNull();
    expect(v.headline).toBe("Waiting on typecheck");
    expect(threadStateView(pin("done"), 165, NOW, "dormant")!.status).toBeNull();
    expect(threadStateView(pin("dormant"), 165, NOW, null)!.status).toBeNull();
  });

  test("with no placement passed, the declared status stands", () => {
    expect(threadStateView(pin("dormant"), 165, NOW)!.status).toBe("dormant");
  });

  test("each placement maps to the status its section stands for", () => {
    expect(declaredOfWorkState("needs_input")).toBe("blocked");
    expect(declaredOfWorkState("dormant")).toBe("dormant");
    expect(declaredOfWorkState("done")).toBe("done");
    expect(declaredOfWorkState("working")).toBe("working");
    expect(declaredOfWorkState("idle")).toBeNull();
    expect(declaredOfWorkState(null)).toBeNull();
  });

  test("the bucket decides where it is a section, so the chip matches the section header", () => {
    // A wait its agent owner answers files under Working while its state says needs_input.
    const working = declaredOfPlacement({ bucket: "working", state: "needs_input" });
    expect(working).toBe("working");
    expect(threadStateView(pin("blocked"), 165, NOW, working)!.status).toBeNull();
    // An open ask files under Questions: a dormant pin there says nothing.
    expect(threadStateView(pin("dormant"), 165, NOW, declaredOfPlacement({ bucket: "questions", state: "dormant" }))!.status).toBeNull();
    expect(declaredOfPlacement({ bucket: "snoozed", state: "done" })).toBe("dormant");
    // A pinned row has no status section: its state decides.
    expect(declaredOfPlacement({ bucket: "pinned", state: "dormant" })).toBe("dormant");
  });
});
