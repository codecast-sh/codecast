import { describe, expect, test } from "bun:test";
import { sessionActivityWords, shortSpan } from "./sessionActivityWords";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const sleeping = (rest: Record<string, unknown>) => ({ state: "sleeping", hibernated: false, ...rest }) as any;

describe("sessionActivityWords", () => {
  test("working and shipping rows keep their own words", () => {
    expect(sessionActivityWords({ state: "working", kind: "subagents", verb: "reviewing", count: 3, words: "3 subagents · reviewing" }, NOW)).toBe("3 subagents · reviewing");
    expect(sessionActivityWords({ state: "shipping", stage: "ci", failed: false, words: "CI running · #263" }, NOW)).toBe("CI running · #263");
  });

  test("a wait names its target the way a person reads it", () => {
    const waiting = (on: unknown) => sleeping({ flavor: "waiting", on, since: null, wake: null });
    expect(sessionActivityWords(waiting({ kind: "person", ref: "@ashot" }), NOW)).toBe("waiting on @ashot");
    expect(sessionActivityWords(waiting({ kind: "session", ref: "k57abcdefghij", label: "jx7c6zk" }), NOW)).toBe("waiting on jx7c6zk");
    expect(sessionActivityWords(waiting({ kind: "task", ref: "ct-12" }), NOW)).toBe("waiting on ct-12 landing");
    expect(sessionActivityWords(waiting({ kind: "pr", ref: "codecast-sh/codecast#42" }), NOW)).toBe("waiting on #42");
  });

  test("a trigger counts down; an event trigger names its event; a stalled row says when it comes back", () => {
    const trigger = (task: unknown, others = 0) => sleeping({ flavor: "scheduled", wake: { kind: "trigger", row: { task }, others } });
    expect(sessionActivityWords(trigger({ status: "scheduled", run_at: NOW + 3 * HOUR }, 1), NOW)).toBe("wakes in 3h · +1 more");
    expect(sessionActivityWords(trigger({ status: "scheduled", event_filter: { event_type: "deploy_live" } }), NOW)).toBe("wakes on deploy_live");
    expect(sessionActivityWords(sleeping({ flavor: "stalled", wake: { kind: "claim", what: null, back: NOW + 20 * 60_000 } }), NOW)).toBe("nothing scheduled · back to you in 20m");
    expect(sessionActivityWords(sleeping({ flavor: "stalled", wake: { kind: "claim", what: null, back: NOW - 1 } }), NOW)).toBe("nothing scheduled · back to you now");
  });

  test("shortSpan never rounds up a unit", () => {
    expect(shortSpan(45_000)).toBe("45s");
    expect(shortSpan(90 * 60_000)).toBe("90m");
    expect(shortSpan(47.9 * HOUR)).toBe("47h");
    expect(shortSpan(71 * HOUR)).toBe("2d");
  });
});
