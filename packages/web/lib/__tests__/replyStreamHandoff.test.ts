import { describe, expect, test } from "bun:test";
import {
  REPLY_STREAM_CLOCK_ALLOWANCE_MS,
  REPLY_STREAM_HANDOFF_PREFIX_CHARS,
  REPLY_STREAM_HANDOFF_SKEW_MS,
  REPLY_STREAM_HANDOFF_STAMP_SLACK_MS,
  REPLY_STREAM_STALE_MS,
} from "@codecast/shared/contracts";
import { replyStreamCanBeMessage, replyStreamFresh, replyStreamHandedOff, replyStreamReceivedAt, replyStreamSlotSig, type StoredReplyStream } from "../replyStreamHandoff";

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
    // Stamped before the stamp slack, so only the text can hand it off.
    expect(replyStreamHandedOff(stream("Hi"), [assistant("Hello", T0 - 2_000)])).toBe(false);
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
    expect(replyStreamHandedOff(row, [assistant("Para one. Para three.", T0 - 2_000)])).toBe(false);
  });
});

describe("replyStreamHandedOff by stamp", () => {
  test("the text written before a tool call, stamped seconds before the next stream began, does not hand it off", () => {
    const row = stream("Now the second part of the answer.", { started_at: T0 });
    const before = assistant("Different words before the tool call.", T0 - 4_000);
    const toolCall = assistant("", T0 + 500, { tool_calls: [{ id: "t1", name: "Read", input: {} }] });
    const thinking = assistant("", T0 + 600, { thinking: "considering" });
    expect(replyStreamHandedOff(row, [before, toolCall, thinking])).toBe(false);
  });

  test("a message whose opening sync rewrote hands it off when stamped after the stream began", () => {
    const row = stream("![shot](/tmp/shot.png) The page loads now.", { started_at: T0 });
    const stored = assistant("![shot](https://files.example/storage/abc) The page loads now.", T0 + 200);
    expect(replyStreamHandedOff(row, [stored])).toBe(true);
    // ... and within the slack before it, but not further back.
    expect(replyStreamHandedOff(row, [assistant("API Error: overloaded", T0 - REPLY_STREAM_HANDOFF_STAMP_SLACK_MS)])).toBe(true);
    expect(replyStreamHandedOff(row, [assistant("API Error: overloaded", T0 - REPLY_STREAM_HANDOFF_STAMP_SLACK_MS - 1)])).toBe(false);
  });

  test("a blank assistant row stamped after the start is not a text row", () => {
    expect(replyStreamHandedOff(stream("Writing"), [assistant("  \n", T0 + 100)])).toBe(false);
  });
});

describe("only a row that can be the stream's message hands it off", () => {
  // Rows the server or the daemon inserts into a live conversation at its own
  // "now", each with the stream's very opening, so neither rule could tell
  // them apart by text or time.
  const opening = "The workflow is running; I will report when the review lands.";
  const inserted = {
    "a workflow event": assistant(opening, T0 + 2_000, { subtype: "workflow_event" }),
    "a scheduled task result": assistant(opening, T0 + 2_000, { subtype: "scheduled_task_result" }),
    "an interactive prompt's prose": assistant(opening, T0 + 2_000, { message_uuid: "interactive-prompt-s1-abc123-prose" }),
    "an interactive prompt's card": assistant(opening, T0 + 2_000, { message_uuid: "interactive-prompt-s1-abc123" }),
    "a limit-dialog banner": assistant(opening, T0 + 2_000, { message_uuid: "limit-dialog-s1-abc123-492000" }),
  };
  for (const [kind, row] of Object.entries(inserted)) {
    test(`${kind} does not`, () => {
      expect(replyStreamCanBeMessage(row)).toBe(false);
      expect(replyStreamHandedOff(stream(opening), [row])).toBe(false);
    });
  }
  test("the transcript's own row does, after any of them", () => {
    const real = assistant(`${opening}\n\nStill going.`, T0 + 300, { message_uuid: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    expect(replyStreamCanBeMessage(real)).toBe(true);
    expect(replyStreamHandedOff(stream(opening), [...Object.values(inserted), real].sort((a, b) => a.timestamp - b.timestamp))).toBe(true);
  });
});

describe("replyStreamReceivedAt", () => {
  const now = T0 + 100_000;
  test("the same push seen again keeps its first stamp", () => {
    const held = stream("text", { seq: 4, received_at: T0 + 3 });
    expect(replyStreamReceivedAt(held, { message_id: "hook-1", seq: 4, updated_at: T0 }, now)).toBe(T0 + 3);
  });
  test("a row first seen is as old as the server says, so a long-stopped reply is stale on arrival", () => {
    const old = { message_id: "hook-1", seq: 9, updated_at: now - 10 * 60_000 };
    const at = replyStreamReceivedAt(undefined, old, now);
    expect(at).toBe(old.updated_at + REPLY_STREAM_CLOCK_ALLOWANCE_MS);
    expect(replyStreamFresh(stream("text", { received_at: at }), now)).toBe(false);
    // A new seq of the held row is a new push.
    expect(replyStreamReceivedAt(stream("text", { seq: 8, received_at: T0 }), old, now)).toBe(at);
  });
  test("a browser clock behind the server's takes its own now, never a stamp from the future", () => {
    const row = { message_id: "hook-2", seq: 1, updated_at: now + 30_000 };
    expect(replyStreamReceivedAt(undefined, row, now)).toBe(now);
  });
  test("a browser clock a little ahead of the server's still reads a fresh push as fresh", () => {
    const row = { message_id: "hook-2", seq: 1, updated_at: now - 4_000 };
    const at = replyStreamReceivedAt(undefined, row, now);
    expect(at).toBe(now);
    expect(replyStreamFresh(stream("t", { received_at: at }), now)).toBe(true);
  });
});

describe("replyStreamFresh", () => {
  test("judged by when this browser received the push", () => {
    const row = stream("text", { updated_at: T0 - 10 * 60_000, received_at: T0 });
    expect(replyStreamFresh(row, T0 + REPLY_STREAM_STALE_MS - 1)).toBe(true);
    expect(replyStreamFresh(row, T0 + REPLY_STREAM_STALE_MS)).toBe(false);
  });
});

describe("replyStreamSlotSig", () => {
  test("names the open reply until its message lands, and does not move on a push", () => {
    const state = { replyStreams: { c1: stream("Working on it") }, messages: { c1: [user("go", T0 - 1_000)] } };
    expect(replyStreamSlotSig(state, "c1")).toBe(`hook-1 ${T0}`);
    expect(replyStreamSlotSig({ ...state, replyStreams: { c1: stream("Working on it, and more", { seq: 2 }) } }, "c1")).toBe(`hook-1 ${T0}`);
    expect(replyStreamSlotSig({ ...state, messages: { c1: [...state.messages.c1, assistant("Working on it now.", T0 + 500)] } }, "c1")).toBe("");
    expect(replyStreamSlotSig({ replyStreams: {}, messages: {} }, "c1")).toBe("");
    expect(replyStreamSlotSig({ replyStreams: { c1: stream("") }, messages: {} }, "c1")).toBe("");
  });
});
