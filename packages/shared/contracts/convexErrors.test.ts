import { describe, expect, test } from "bun:test";
import { cliErrorMessage, humanizeConvexError, unknownServerArg } from "./convexErrors";

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

describe("cliErrorMessage", () => {
  // What /cli/tasks/create answered for `cast trigger add --source <unknown>`
  // before the CLI cleaned it: the throw text with its Convex stack.
  test("a refusal from an http route prints as its one line", () => {
    const raw = 'Uncaught Error: No source "zzz" in this trigger\'s workspace. Known: e2e-sdk (src-2)\n'
      + "    at triggerSourceName (../../convex/ingest.ts:84:0)\n"
      + "    at async storedEventFilter (../../convex/agentTasks.ts:2491:0)";
    expect(cliErrorMessage(raw)).toBe('No source "zzz" in this trigger\'s workspace. Known: e2e-sdk (src-2)');
  });

  test("redacts the api_token an argument dump carries", () => {
    const raw = 'ArgumentValidationError: Object is missing the required field `title`.\n\nObject: {api_token: "cc_secret_123", prompt: "x"}';
    const line = cliErrorMessage(raw);
    expect(line).not.toContain("cc_secret_123");
    expect(line).toContain('api_token: "***"');
  });

  test("a ConvexError's data reads as its message", () => {
    expect(cliErrorMessage('Uncaught ConvexError: {"code":"FORBIDDEN","message":"Not your trigger"}')).toBe("Not your trigger");
  });

  test("nothing left reads as Unknown error", () => {
    expect(cliErrorMessage("")).toBe("Unknown error");
  });
});

test("String(err) of a wrapped server error, with its own name first", () => {
  const text = String(new Error("[CONVEX M(dispatch:dispatch)] [Request ID: x] Server Error\nUncaught ConvexError: That machine is not yours"));
  expect(humanizeConvexError(text)).toBe("That machine is not yours");
});

describe("an argument the deployment does not know", () => {
  // A Convex validator is a closed object, so an argument added after the
  // running deployment was pushed takes the whole call down with it. CLI
  // releases auto-update ahead of a convex push, so this is what a person
  // hits first, and a validator dump tells them nothing.
  const raw = {
    message:
      "[CONVEX A(plans:get)] [Request ID: abc] Server Error\nUncaught ArgumentValidationError: Object contains extra field `conversation_id` that is not in the validator. Validator: v.object({api_token: v.string(), short_id: v.string()})",
  };

  test("is named, so a read can ask again without it", () => {
    expect(unknownServerArg(raw)).toBe("conversation_id");
    expect(unknownServerArg({ message: "Uncaught Error: Task not found" })).toBeNull();
  });

  test("reads as the cause rather than a validator dump", () => {
    const line = cliErrorMessage(raw);
    expect(line).toContain("older than your CLI");
    expect(line).toContain("conversation_id");
    expect(line).not.toContain("v.object");
  });
});
