import { describe, expect, test } from "bun:test";
import { argumentValidationProblem, cliErrorMessage, humanizeConvexError } from "./convexErrors";

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

  test("an argument refusal prints its sentence, never the arguments it dumped", () => {
    const raw = 'ArgumentValidationError: Object is missing the required field `title`.\n\nObject: {api_token: "cc_secret_123", prompt: "x"}';
    expect(cliErrorMessage(raw)).toBe("Object is missing the required field `title`.");
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

// A validator's refusal dumps the whole call: the api token, and on a Vault
// write the value being saved. Shapes as prod sends them (2026-10-23).
describe("argumentValidationProblem", () => {
  const TOKEN = "cc_" + "t".repeat(40);
  const VALUE = "zz-FAKE-VALUE-123";
  test("an extra field names the field and nothing it carried", () => {
    const raw = `ArgumentValidationError: Object contains extra field \`kind_hint\` that is not in the validator.\n\nObject: {api_token: "${TOKEN}", kind: "key", name: "zz-x", payload: {value: "${VALUE}"}, kind_hint: "x"}\nValidator: v.object({api_token: v.optional(v.string())})`;
    expect(argumentValidationProblem(raw)).toBe("Object contains extra field `kind_hint` that is not in the validator.");
  });
  test("a mismatched value keeps its path and drops the value", () => {
    const raw = `Uncaught ArgumentValidationError: Value does not match validator.\nPath: .payload\nValue: {value: "${VALUE}"}\nValidator: v.string()`;
    expect(argumentValidationProblem(raw)).toBe("Value does not match validator. Path: .payload");
  });
  test("the web client's wrapped error reads the same, through humanizeConvexError", () => {
    const err = new Error(`[CONVEX A(secrets:create)] [Request ID: 1a2b] Server Error\nArgumentValidationError: Object contains extra field \`x\` that is not in the validator.\n\nObject: {payload: {value: "${VALUE}"}, x: 1}`);
    const line = humanizeConvexError(err);
    expect(line).toBe("Object contains extra field `x` that is not in the validator.");
    expect(line).not.toContain(VALUE);
  });
  test("any other error is not one", () => {
    expect(argumentValidationProblem(new Error("Unauthorized"))).toBeNull();
  });
});

test("the CLI's ConvexHttpClient error, which has no call tag before its request id", () => {
  const raw = '[Request ID: f0407b2310c444df] Server Error\nUncaught Error: Invalid SSH host. Use letters, digits, and . - _ @ : only.\n    at handler [as handler] (../../convex/devices.ts:1564:8)\n';
  expect(cliErrorMessage(raw)).toBe("Invalid SSH host. Use letters, digits, and . - _ @ : only.");
});
