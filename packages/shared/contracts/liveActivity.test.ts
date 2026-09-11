import { describe, expect, test } from "bun:test";
import {
  LIVE_ACTIVITY_DISPLAYED_SESSIONS,
  LIVE_ACTIVITY_DONE_LINGER_MS,
  LIVE_ACTIVITY_FAILED_LINGER_MS,
  LIVE_ACTIVITY_SCHEMA_VERSION,
  LIVE_ACTIVITY_TITLE_LIMIT,
  clipLiveActivityText,
  deriveLiveActivityState,
  isLiveActivityQuiet,
  liveActivityStateKey,
  liveActivityStatusKey,
  liveActivityStatusOf,
  nextLiveActivityExpiry,
  type LiveActivitySessionInput,
} from "./liveActivity";

const NOW = 1_700_000_000_000;

function session(over: Partial<LiveActivitySessionInput> & { id: string }): LiveActivitySessionInput {
  return {
    title: `Session ${over.id}`,
    agent: "claude",
    status: "working",
    startedAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    ...over,
  };
}

describe("liveActivityStatusOf", () => {
  test("maps the inbox buckets onto the strip", () => {
    expect(liveActivityStatusOf("working")).toBe("working");
    expect(liveActivityStatusOf("needs_input")).toBe("waiting");
    expect(liveActivityStatusOf("needs_input", { failed: true })).toBe("failed");
    expect(liveActivityStatusOf("done")).toBe("done");
  });
  test("parked and blank rows have no place on the Lock Screen", () => {
    expect(liveActivityStatusOf("dormant")).toBeNull();
    expect(liveActivityStatusOf("idle")).toBeNull();
  });
});

describe("deriveLiveActivityState", () => {
  test("no sessions reads All clear and is quiet", () => {
    const state = deriveLiveActivityState([], NOW);
    expect(state.headline).toBe("All clear");
    expect(state.detail).toBeNull();
    expect(state.status).toBe("done");
    expect(state.live).toBe(0);
    expect(state.version).toBe(LIVE_ACTIVITY_SCHEMA_VERSION);
    expect(isLiveActivityQuiet(state)).toBe(true);
  });

  test("one session shows its own title and detail", () => {
    const state = deriveLiveActivityState(
      [session({ id: "a", title: "Running migrations", detail: "3 of 7 applied", project: "codecast" })],
      NOW,
    );
    expect(state.headline).toBe("Running migrations");
    expect(state.detail).toBe("3 of 7 applied");
    expect(state.sessions[0]).toMatchObject({ id: "a", project: "codecast", status: "working" });
    expect(state.sessions[0].startedAt).toBe(new Date(NOW - 60_000).toISOString());
  });

  test("waiting floats to the top and leads the headline", () => {
    const state = deriveLiveActivityState(
      [
        session({ id: "w1", status: "working", startedAt: NOW - 300_000 }),
        session({ id: "q", status: "waiting", title: "Approve the migration?", project: "api" }),
        session({ id: "w2", status: "working", startedAt: NOW - 100_000 }),
      ],
      NOW,
    );
    expect(state.headline).toBe("Waiting on you");
    expect(state.detail).toBe("api · Approve the migration?");
    expect(state.status).toBe("waiting");
    expect(state.waiting).toBe(1);
    expect(state.live).toBe(3);
    expect(state.sessions.map((s) => s.id)).toEqual(["q", "w1", "w2"]);
  });

  test("two waiting sessions count in the headline", () => {
    const state = deriveLiveActivityState(
      [session({ id: "a", status: "waiting" }), session({ id: "b", status: "waiting" })],
      NOW,
    );
    expect(state.headline).toBe("2 waiting on you");
  });

  test("a failure outranks working in the headline even while others run", () => {
    const state = deriveLiveActivityState(
      [session({ id: "a" }), session({ id: "b", status: "failed" }), session({ id: "c" })],
      NOW,
    );
    expect(state.headline).toBe("1 failed");
    expect(state.sessions[0].id).toBe("b");
  });

  test("all working reads as a count, ordered by start so rows keep their place", () => {
    const state = deriveLiveActivityState(
      [
        session({ id: "late", startedAt: NOW - 10_000, updatedAt: NOW }),
        session({ id: "early", startedAt: NOW - 90_000, updatedAt: NOW - 50_000 }),
      ],
      NOW,
    );
    expect(state.headline).toBe("2 agents working");
    expect(state.sessions.map((s) => s.id)).toEqual(["early", "late"]);
  });

  test("done and failed rows order by most recent transition", () => {
    const state = deriveLiveActivityState(
      [
        session({ id: "old", status: "done", updatedAt: NOW - 60_000 }),
        session({ id: "new", status: "done", updatedAt: NOW - 5_000 }),
      ],
      NOW,
    );
    expect(state.headline).toBe("Done");
    expect(state.sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  test("a finished session lingers, then leaves", () => {
    const rows = [session({ id: "d", status: "done", updatedAt: NOW - LIVE_ACTIVITY_DONE_LINGER_MS + 1 })];
    expect(deriveLiveActivityState(rows, NOW).sessions).toHaveLength(1);
    expect(deriveLiveActivityState(rows, NOW + 1).sessions).toHaveLength(0);
  });

  test("a failure lingers longer than a finish", () => {
    const rows = [session({ id: "f", status: "failed", updatedAt: NOW - LIVE_ACTIVITY_DONE_LINGER_MS })];
    expect(deriveLiveActivityState(rows, NOW).sessions).toHaveLength(1);
    expect(deriveLiveActivityState(rows, NOW + LIVE_ACTIVITY_FAILED_LINGER_MS).sessions).toHaveLength(0);
  });

  test("rows past the display cap fold into overflow", () => {
    const rows = Array.from({ length: LIVE_ACTIVITY_DISPLAYED_SESSIONS + 3 }, (_, i) =>
      session({ id: `s${i}`, startedAt: NOW - i * 1000 }),
    );
    const state = deriveLiveActivityState(rows, NOW);
    expect(state.sessions).toHaveLength(LIVE_ACTIVITY_DISPLAYED_SESSIONS);
    expect(state.overflow).toBe(3);
    expect(state.live).toBe(rows.length);
  });

  test("titles and details are clipped for the payload", () => {
    const long = "x".repeat(200);
    const state = deriveLiveActivityState([session({ id: "a", title: long, detail: long })], NOW);
    expect(state.headline.length).toBeLessThanOrEqual(LIVE_ACTIVITY_TITLE_LIMIT);
    expect(state.sessions[0].title.length).toBeLessThanOrEqual(LIVE_ACTIVITY_TITLE_LIMIT);
    expect(state.headline.endsWith("…")).toBe(true);
  });

  test("optional fields are omitted, never null, so the Swift decoder stays plain", () => {
    const state = deriveLiveActivityState([session({ id: "a", detail: null, project: null })], NOW);
    expect("detail" in state.sessions[0]).toBe(false);
    expect("project" in state.sessions[0]).toBe(false);
  });
});

describe("clipLiveActivityText", () => {
  test("collapses whitespace and clips with an ellipsis", () => {
    expect(clipLiveActivityText("  a \n b  ", 10)).toBe("a b");
    expect(clipLiveActivityText("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("state keys", () => {
  test("the state key ignores the clock", () => {
    const a = deriveLiveActivityState([session({ id: "a" })], NOW);
    const b = deriveLiveActivityState([session({ id: "a" })], NOW + 30_000);
    expect(liveActivityStateKey(a)).toBe(liveActivityStateKey(b));
  });
  test("the state key sees a title change", () => {
    const a = deriveLiveActivityState([session({ id: "a", title: "one" })], NOW);
    const b = deriveLiveActivityState([session({ id: "a", title: "two" })], NOW);
    expect(liveActivityStateKey(a)).not.toBe(liveActivityStateKey(b));
  });
  test("the status key sees only membership and status", () => {
    const a = deriveLiveActivityState([session({ id: "a", title: "one" })], NOW);
    const b = deriveLiveActivityState([session({ id: "a", title: "two" })], NOW);
    const c = deriveLiveActivityState([session({ id: "a", status: "waiting" })], NOW);
    expect(liveActivityStatusKey(a)).toBe(liveActivityStatusKey(b));
    expect(liveActivityStatusKey(a)).not.toBe(liveActivityStatusKey(c));
  });
});

describe("nextLiveActivityExpiry", () => {
  test("names the earliest linger expiry still ahead", () => {
    const at = nextLiveActivityExpiry(
      [
        { status: "working", updatedAt: NOW },
        { status: "done", updatedAt: NOW - 10_000 },
        { status: "failed", updatedAt: NOW - 10_000 },
      ],
      NOW,
    );
    expect(at).toBe(NOW - 10_000 + LIVE_ACTIVITY_DONE_LINGER_MS);
  });
  test("nothing lingering means no wake", () => {
    expect(nextLiveActivityExpiry([{ status: "working", updatedAt: NOW }], NOW)).toBeNull();
  });
});
