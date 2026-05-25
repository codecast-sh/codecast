import { describe, expect, test } from "bun:test";
import {
  filterUserMessages,
  type FilterableMessage,
} from "./userMessagesFilter";

const msg = (overrides: Partial<FilterableMessage>): FilterableMessage => ({
  _id: overrides._id ?? "m1",
  message_uuid: overrides.message_uuid,
  role: overrides.role ?? "user",
  content: overrides.content,
  tool_calls: overrides.tool_calls,
  tool_results: overrides.tool_results,
  subtype: overrides.subtype,
  timestamp: overrides.timestamp ?? 0,
});

describe("filterUserMessages", () => {
  test("returns user messages sorted ascending by timestamp", () => {
    const out = filterUserMessages([
      msg({ _id: "u2", role: "user", content: "second user", timestamp: 200 }),
      msg({ _id: "u1", role: "user", content: "first user", timestamp: 100 }),
    ]);
    expect(out.map((m) => m._id)).toEqual(["u1", "u2"]);
    expect(out.every((m) => m.role === "user")).toBe(true);
  });

  test("never returns assistant messages, even if passed in", () => {
    // The user-prompt navigators (message browser, rewind/fork) are user-only.
    // This guard lives at the source so no client has to re-filter by role.
    const out = filterUserMessages([
      msg({ _id: "a1", role: "assistant", content: "assistant prose here", timestamp: 1 }),
      msg({ _id: "u1", role: "user", content: "real question", timestamp: 2 }),
    ]);
    expect(out.map((m) => m._id)).toEqual(["u1"]);
  });

  test("drops compact_boundary", () => {
    const out = filterUserMessages([
      msg({ _id: "u1", role: "user", content: "real", subtype: "compact_boundary", timestamp: 1 }),
    ]);
    expect(out).toEqual([]);
  });

  test("drops messages with empty / whitespace content", () => {
    const out = filterUserMessages([
      msg({ _id: "u1", role: "user", content: "   ", timestamp: 1 }),
    ]);
    expect(out).toEqual([]);
  });

  test("strips context tags from user content before noise checks", () => {
    const out = filterUserMessages([
      msg({
        _id: "u1",
        role: "user",
        content: "<system-reminder>noise</system-reminder>real reply",
        timestamp: 1,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("real reply");
  });

  test("drops user noise prefixes like <local-command-stdout> and Caveat:", () => {
    const out = filterUserMessages([
      msg({ _id: "u1", role: "user", content: "<local-command-stdout>ls", timestamp: 1 }),
      msg({ _id: "u2", role: "user", content: "Caveat: env var changed", timestamp: 2 }),
      msg({ _id: "u3", role: "user", content: "real question", timestamp: 3 }),
    ]);
    expect(out.map((m) => m._id)).toEqual(["u3"]);
  });

  test("drops summary-prompt user messages", () => {
    const out = filterUserMessages([
      msg({
        _id: "u1",
        role: "user",
        content: "Your task is to create a detailed summary of the conversation so far. Please...",
        timestamp: 1,
      }),
    ]);
    expect(out).toEqual([]);
  });

  test("drops tool-result-only user turns (very short prose)", () => {
    const out = filterUserMessages([
      msg({
        _id: "u1",
        role: "user",
        content: "ok",
        tool_results: [{ tool_use_id: "x", content: "result" }],
        timestamp: 1,
      }),
    ]);
    expect(out).toEqual([]);
  });

  test("truncates returned content at 500 chars", () => {
    const long = "x".repeat(750);
    const out = filterUserMessages([
      msg({ _id: "u1", role: "user", content: long, timestamp: 1 }),
    ]);
    expect(out[0].content).toHaveLength(500);
  });

  test("falls back to original content when stripping leaves an empty body", () => {
    const out = filterUserMessages([
      msg({
        _id: "u1",
        role: "user",
        content: "<system-reminder>only-noise</system-reminder>",
        timestamp: 1,
      }),
    ]);
    expect(out).toEqual([]);
  });
});
