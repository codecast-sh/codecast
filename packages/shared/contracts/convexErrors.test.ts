import { describe, expect, test } from "bun:test";
import { humanizeConvexError } from "./convexErrors";

describe("humanizeConvexError", () => {
  test("structured ConvexError data answers with its message", () => {
    expect(humanizeConvexError({ data: { code: "NOT_FOUND", message: "Channel not found" } })).toBe("Channel not found");
  });

  test("strips the client wrapper and the stack tail", () => {
    const err = new Error(
      "[CONVEX M(chat:sendMessage)] [Request ID: abc] Server Error\nUncaught Error: This channel is archived\n    at handler (../convex/chat.ts:1:1)",
    );
    expect(humanizeConvexError(err)).toBe("This channel is archived");
  });

  // A chat send rides dispatch.dispatch, which runs chat.sendMessage through
  // ctx.runMutation: the inner ConvexError's data reaches the client flattened
  // into the outer message, one "Uncaught ConvexError:" lead per hop.
  test("a throw that crossed a runMutation hop reads as the inner message", () => {
    const err = new Error(
      "[CONVEX M(dispatch:dispatch)] [Request ID: 1fd87ef566d41f67] Server Error\n"
      + 'Uncaught ConvexError: Uncaught ConvexError: {"code":"NOT_FOUND","message":"Channel not found","retryable":false}\n'
      + "    at chatFail (../../convex/chat.ts:103:4)",
    );
    expect(humanizeConvexError(err)).toBe("Channel not found");
  });

  test("falls back when nothing is left", () => {
    expect(humanizeConvexError(new Error(""), "Not sent")).toBe("Not sent");
    expect(humanizeConvexError(new Error("{not json"))).toBe("{not json");
  });
});
