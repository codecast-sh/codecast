import { describe, expect, test } from "bun:test";
import {
  REPLY_STREAM_HANDOFF_PREFIX_CHARS,
  REPLY_STREAM_HANDOFF_SKEW_MS,
  REPLY_STREAM_STALE_MS,
} from "@codecast/shared/contracts";
import { replyStreamFresh, replyStreamHandedOff, replyStreamOpen, type StoredReplyStream } from "../replyStreamHandoff";

const T0 = 1_800_000_000_000;

function stream(text: string, over: Partial<StoredReplyStream> = {}): StoredReplyStream {
  return { _id: "c1", conversation_id: "c1", message_id: "hook-1", text, seq: 1, started_at: T0, updated_at: T0, received_at: T0, ...over };
}
const assistant = (content: string, timestamp: number, extra: Record<string, unknown> = {}) => ({ _id: `m${timestamp}`, role: "assistant", content, timestamp, ...extra });
const user = (content: string, timestamp: number) => ({ _id: `u${timestamp}`, role: "user", content, timestamp });

describe("replyStreamHandedOff", () => {
  test("text before a tool call does not hand off the text written after it; the later message does", () => {
    const before = assistant("Let me read the config first.", T0 - 5_000);
    const toolCall = assistant("", T0 - 4_000, { tool_calls: [{ id: "t1", name: "Read", input: {} }] });
    const toolResult = user("", T0 - 3_000);
    const later = stream("The config sets the port to 3200.\n\nSo the server", { started_at: T0 });
    const messages = [user("What port?", T0 - 10_000), before, toolCall, toolResult];
    expect(replyStreamHandedOff(later, messages)).toBe(false);
    expect(replyStreamHandedOff(later, [...messages, assistant("The config sets the port to 3200.\n\nSo the server listens there.", T0 + 2_000)])).toBe(true);
  });

  test("an interrupted reply whose stored message runs past the stream hands it off", () => {
    const row = stream("First paragraph.\nSecond");
    expect(replyStreamHandedOff(row, [assistant("First paragraph.\nSecond paragraph, cut off when the turn was interru", T0 + 1_000)])).toBe(true);
  });

  test("an older message with the same opening outside the skew window does not hand off", () => {
    const row = stream("Done. All tests pass.");
    const old = assistant("Done. All tests pass.", T0 - REPLY_STREAM_HANDOFF_SKEW_MS - 1);
    expect(replyStreamHandedOff(row, [old])).toBe(false);
    // The walk stops at the first message older than the window, so an older
    // match behind it is never reached either.
    expect(replyStreamHandedOff(row, [assistant("Done. All tests pass.", T0 - 10 * 60_000), old])).toBe(false);
  });

  test("one inside the window does: hiding a live reply only shows what the view showed before streaming", () => {
    const row = stream("Done. All tests pass.");
    expect(replyStreamHandedOff(row, [assistant("Done. All tests pass.", T0 - REPLY_STREAM_HANDOFF_SKEW_MS + 1)])).toBe(true);
  });

  test("a stream shorter than the prefix is matched whole, and only the prefix of a long one counts", () => {
    expect(replyStreamHandedOff(stream("Hi"), [assistant("Hi there", T0)])).toBe(true);
    expect(replyStreamHandedOff(stream("Hi"), [assistant("Hello", T0)])).toBe(false);
    const opening = "x".repeat(REPLY_STREAM_HANDOFF_PREFIX_CHARS);
    expect(replyStreamHandedOff(stream(`${opening} and the stream goes on`), [assistant(`${opening} but the message says otherwise`, T0)])).toBe(true);
  });

  test("only an assistant message hands off", () => {
    expect(replyStreamHandedOff(stream("Same words"), [user("Same words", T0 + 1)])).toBe(false);
  });

  test("an empty stream is handed off: nothing to draw", () => {
    expect(replyStreamHandedOff(stream(""), [])).toBe(true);
    expect(replyStreamHandedOff(stream("  \n "), undefined)).toBe(true);
  });

  test("whitespace compares the way the stored message holds it: untrimmed, lines joined either way", () => {
    // The transcript row keeps the block as written (leading blank lines,
    // a blank line between paragraphs); the stream joins the hook's lines.
    const row = stream("Para one.\nPara two\n");
    expect(replyStreamHandedOff(row, [assistant("\n\nPara one.\n\nPara two goes on.", T0)])).toBe(true);
    expect(replyStreamHandedOff(row, [assistant("Para one. Para three.", T0)])).toBe(false);
  });
});

describe("replyStreamFresh", () => {
  test("judged by when this browser received the push", () => {
    const row = stream("text", { updated_at: T0 - 10 * 60_000, received_at: T0 });
    expect(replyStreamFresh(row, T0 + REPLY_STREAM_STALE_MS - 1)).toBe(true);
    expect(replyStreamFresh(row, T0 + REPLY_STREAM_STALE_MS)).toBe(false);
  });
});

describe("replyStreamOpen", () => {
  test("open while the row has text and its message has not landed", () => {
    const state = { replyStreams: { c1: stream("Working on it") }, messages: { c1: [user("go", T0 - 1_000)] } };
    expect(replyStreamOpen(state, "c1")).toBe(true);
    expect(replyStreamOpen({ ...state, messages: { c1: [...state.messages.c1, assistant("Working on it now.", T0 + 500)] } }, "c1")).toBe(false);
    expect(replyStreamOpen({ replyStreams: {}, messages: {} }, "c1")).toBe(false);
    expect(replyStreamOpen({ replyStreams: { c1: stream("") }, messages: {} }, "c1")).toBe(false);
  });
});
