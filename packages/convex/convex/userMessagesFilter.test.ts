import { describe, expect, test } from "bun:test";
import {
  filterAndMergeUserMessages,
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

describe("filterAndMergeUserMessages", () => {
  test("merges user and assistant messages and sorts ascending by timestamp", () => {
    // Repro for codecast: f41fd8e9 — server crashed with
    // "assistantMsgs is not defined" before this path got assertions.
    const userMsgs = [
      msg({ _id: "u2", role: "user", content: "second user", timestamp: 200 }),
      msg({ _id: "u1", role: "user", content: "first user", timestamp: 100 }),
    ];
    const assistantMsgs = [
      msg({ _id: "a2", role: "assistant", content: "second assistant", timestamp: 250 }),
      msg({ _id: "a1", role: "assistant", content: "first assistant", timestamp: 150 }),
    ];

    const out = filterAndMergeUserMessages(userMsgs, assistantMsgs);

    expect(out.map((m) => m._id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(out.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  test("returns assistant messages when only assistants are present", () => {
    const out = filterAndMergeUserMessages(
      [],
      [msg({ _id: "a1", role: "assistant", content: "hello world", timestamp: 1 })],
    );
    expect(out).toEqual([
      { _id: "a1", message_uuid: undefined, role: "assistant", content: "hello world", timestamp: 1 },
    ]);
  });

  test("drops compact_boundary regardless of role", () => {
    const out = filterAndMergeUserMessages(
      [msg({ _id: "u1", role: "user", content: "real", subtype: "compact_boundary", timestamp: 1 })],
      [msg({ _id: "a1", role: "assistant", content: "real", subtype: "compact_boundary", timestamp: 2 })],
    );
    expect(out).toEqual([]);
  });

  test("drops messages with empty / whitespace content", () => {
    const out = filterAndMergeUserMessages(
      [msg({ _id: "u1", role: "user", content: "   ", timestamp: 1 })],
      [msg({ _id: "a1", role: "assistant", content: "", timestamp: 2 })],
    );
    expect(out).toEqual([]);
  });

  test("strips context tags from user content before noise checks", () => {
    const out = filterAndMergeUserMessages(
      [msg({
        _id: "u1",
        role: "user",
        content: "<system-reminder>noise</system-reminder>real reply",
        timestamp: 1,
      })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("real reply");
  });

  test("drops user noise prefixes like <local-command-stdout> and Caveat:", () => {
    const out = filterAndMergeUserMessages(
      [
        msg({ _id: "u1", role: "user", content: "<local-command-stdout>ls", timestamp: 1 }),
        msg({ _id: "u2", role: "user", content: "Caveat: env var changed", timestamp: 2 }),
        msg({ _id: "u3", role: "user", content: "real question", timestamp: 3 }),
      ],
      [],
    );
    expect(out.map((m) => m._id)).toEqual(["u3"]);
  });

  test("drops summary-prompt user messages", () => {
    const out = filterAndMergeUserMessages(
      [msg({
        _id: "u1",
        role: "user",
        content: "Your task is to create a detailed summary of the conversation so far. Please...",
        timestamp: 1,
      })],
      [],
    );
    expect(out).toEqual([]);
  });

  test("drops tool-result-only user turns (very short prose)", () => {
    const out = filterAndMergeUserMessages(
      [msg({
        _id: "u1",
        role: "user",
        content: "ok",
        tool_results: [{ tool_use_id: "x", content: "result" }],
        timestamp: 1,
      })],
      [],
    );
    expect(out).toEqual([]);
  });

  test("drops short assistant turns that only carry tool calls", () => {
    const out = filterAndMergeUserMessages(
      [],
      [msg({
        _id: "a1",
        role: "assistant",
        content: "ok",
        tool_calls: [{ id: "t1", name: "Bash", input: "{}" }],
        timestamp: 1,
      })],
    );
    expect(out).toEqual([]);
  });

  test("keeps assistant turns with substantive prose alongside tool calls", () => {
    const out = filterAndMergeUserMessages(
      [],
      [msg({
        _id: "a1",
        role: "assistant",
        content: "I'll grep the conversations file for the broken reference first.",
        tool_calls: [{ id: "t1", name: "Bash", input: "{}" }],
        timestamp: 1,
      })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]._id).toBe("a1");
  });

  test("truncates returned content at 500 chars", () => {
    const long = "x".repeat(750);
    const out = filterAndMergeUserMessages(
      [msg({ _id: "u1", role: "user", content: long, timestamp: 1 })],
      [],
    );
    expect(out[0].content).toHaveLength(500);
  });

  test("falls back to original content when stripping leaves an empty body", () => {
    // After tag-stripping the content is empty so the row gets filtered out;
    // assert that branch instead of trying to round-trip empty into the output.
    const out = filterAndMergeUserMessages(
      [msg({
        _id: "u1",
        role: "user",
        content: "<system-reminder>only-noise</system-reminder>",
        timestamp: 1,
      })],
      [],
    );
    expect(out).toEqual([]);
  });
});
