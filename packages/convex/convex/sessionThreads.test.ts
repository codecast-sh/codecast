import { describe, expect, test } from "bun:test";
import { pickSendingMessage } from "./sessionThreads";

// The body a worker received, verbatim, as it appears inside the lead's
// SendMessage tool call.
const BODY = "Review task ct-49576 (browser bridge test helper overwrote the human's real extension pairing file) for plan pl-552.\n\nInspect with git diff in the worktree; do not modify files.";

const sendCall = (body: string) => ({
  input: JSON.stringify({ to: "review-ct-49576", message: body }),
});

describe("pickSendingMessage", () => {
  test("finds the turn whose tool call carries the received text", () => {
    const messages = [
      { _id: "older", timestamp: 900, content: "thinking about the queue" },
      { _id: "sender", timestamp: 950, tool_calls: [sendCall(BODY)] },
      { _id: "newer", timestamp: 980, content: "sent it" },
    ];
    expect(pickSendingMessage(messages, 1000, BODY)?._id).toBe("sender");
  });

  test("matches across the JSON escaping of newlines in a tool input", () => {
    const messages = [{ _id: "sender", timestamp: 950, tool_calls: [sendCall(BODY)] }];
    // An excerpt spanning the blank line only matches once the input's string
    // fields are parsed out — the raw input has a literal backslash-n there.
    const spanning = "for plan pl-552.\n\nInspect with git diff";
    expect(pickSendingMessage(messages, 1000, spanning)?._id).toBe("sender");
  });

  test("tolerates re-wrapping and indentation in the excerpt", () => {
    const messages = [{ _id: "sender", timestamp: 950, tool_calls: [sendCall(BODY)] }];
    const rewrapped = "Review  task ct-49576\n   (browser bridge test helper";
    expect(pickSendingMessage(messages, 1000, rewrapped)?._id).toBe("sender");
  });

  test("prefers the send over a later turn that quotes it back", () => {
    const messages = [
      { _id: "sender", timestamp: 950, tool_calls: [sendCall(BODY)] },
      { _id: "quote", timestamp: 990, content: BODY },
    ];
    expect(pickSendingMessage(messages, 1000, BODY)?._id).toBe("sender");
  });

  test("reaches forward when the sender's clock ran behind delivery", () => {
    const messages = [
      { _id: "earlier", timestamp: 900, content: "unrelated" },
      { _id: "sender", timestamp: 1100, tool_calls: [sendCall(BODY)] },
    ];
    expect(pickSendingMessage(messages, 1000, BODY)?._id).toBe("sender");
  });

  test("falls back to the last turn before delivery when nothing carries the text", () => {
    const messages = [
      { _id: "older", timestamp: 900, content: "a" },
      { _id: "last", timestamp: 950, content: "b" },
      { _id: "after", timestamp: 1100, content: "c" },
    ];
    expect(pickSendingMessage(messages, 1000, BODY)?._id).toBe("last");
  });

  test("finds the send that waited hours in the queue before delivery", () => {
    const sentAt = 1000 - 5 * 60 * 60 * 1000;
    const messages = [
      { _id: "sender", timestamp: sentAt, tool_calls: [sendCall(BODY)] },
      { _id: "chatter", timestamp: sentAt + 60_000, content: "moved on" },
    ];
    expect(pickSendingMessage(messages, 1000, BODY)?._id).toBe("sender");
  });

  test("declines to guess a spot when the nearest turn is long before delivery", () => {
    const messages = [{ _id: "stale", timestamp: 1000 - 30 * 60 * 1000, content: "unrelated" }];
    expect(pickSendingMessage(messages, 1000, BODY)).toBeNull();
  });

  test("an excerpt too short to be distinctive never claims a turn", () => {
    const messages = [
      { _id: "last", timestamp: 950, content: "b" },
      { _id: "hit", timestamp: 960, tool_calls: [{ input: "the" }] },
    ];
    // "the" would match almost anything, so the search is skipped and the
    // fallback answers with the newest turn before delivery.
    expect(pickSendingMessage(messages, 1000, "the")?._id).toBe("hit");
    expect(pickSendingMessage([{ _id: "last", timestamp: 950, content: "b" }], 1000, "the")?._id).toBe("last");
  });

  test("no turn before delivery and no match yields nothing", () => {
    expect(pickSendingMessage([{ _id: "after", timestamp: 1100, content: "c" }], 1000, "")).toBeNull();
  });
});
