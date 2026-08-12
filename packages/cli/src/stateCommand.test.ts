import { describe, test, expect } from "bun:test";
import { parseStateArgs, formatAge, describeProvenance } from "./stateCommand.js";

describe("parseStateArgs", () => {
  test("no args reads the current state", () => {
    expect(parseStateArgs([])).toEqual({ mode: "show", session: undefined });
  });

  test("a bare string is the state text", () => {
    expect(parseStateArgs(["Waiting on CI"])).toEqual({
      mode: "set",
      text: "Waiting on CI",
      session: undefined,
    });
  });

  test("clear words remove the state", () => {
    for (const word of ["clear", "rm", "unset", "none", "CLEAR"]) {
      expect(parseStateArgs([word]).mode).toBe("clear");
    }
  });

  test("a bare \"done\" is state text, not a clear — the agent may mean it", () => {
    expect(parseStateArgs(["done"])).toEqual({ mode: "set", text: "done", session: undefined });
  });

  test("a clear word followed by more text is text, not a clear", () => {
    expect(parseStateArgs(["done", "with", "the", "migration"])).toEqual({
      mode: "set",
      text: "done with the migration",
      session: undefined,
    });
  });

  test("text that merely starts with a verb-like word stays text", () => {
    expect(parseStateArgs(["cleared the queue, waiting"]).mode).toBe("set");
  });

  test("explicit set takes the rest as text", () => {
    expect(parseStateArgs(["set", "Blocked: needs a key"])).toEqual({
      mode: "set",
      text: "Blocked: needs a key",
      session: undefined,
    });
  });

  test("show takes an optional session and beats --for", () => {
    expect(parseStateArgs(["show", "jx7c6zk"], "jx7other")).toEqual({
      mode: "show",
      session: "jx7c6zk",
    });
    expect(parseStateArgs(["show"], "jx7other")).toEqual({ mode: "show", session: "jx7other" });
  });

  test("--for targets a write at another session", () => {
    expect(parseStateArgs(["Waiting on CI"], "jx7c6zk")).toEqual({
      mode: "set",
      text: "Waiting on CI",
      session: "jx7c6zk",
    });
  });
});

describe("formatAge", () => {
  test("reads naturally across the scale", () => {
    expect(formatAge(10_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5 min ago");
    expect(formatAge(60 * 60_000)).toBe("1 hour ago");
    expect(formatAge(5 * 60 * 60_000)).toBe("5 hours ago");
    expect(formatAge(26 * 60 * 60_000)).toBe("1 day ago");
    expect(formatAge(72 * 60 * 60_000)).toBe("3 days ago");
  });
});

describe("describeProvenance", () => {
  const now = 1_700_000_000_000;

  test("reports age and the message gap", () => {
    const line = describeProvenance(
      { at: now - 5 * 60_000, msg_count_at_write: 100, message_count: 103 },
      now,
    );
    expect(line).toBe("set 5 min ago, 3 messages since");
  });

  test("singular message reads correctly", () => {
    const line = describeProvenance(
      { at: now - 60_000, msg_count_at_write: 10, message_count: 11 },
      now,
    );
    expect(line).toContain("1 message since");
  });

  test("a far-behind state says so out loud", () => {
    const line = describeProvenance(
      { at: now - 60_000, msg_count_at_write: 0, message_count: 500 },
      now,
    );
    expect(line).toContain("likely stale");
  });

  test("a row with no stored count omits the gap rather than claiming zero", () => {
    const line = describeProvenance({ at: now - 60_000, message_count: 500 }, now);
    expect(line).toBe("set 1 min ago");
  });
});
