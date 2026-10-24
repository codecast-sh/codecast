import { expect, spyOn, test } from "bun:test";
import { cliErrorReply } from "./cliErrorStatus";

// What prod's runAction threw for /cli/vault/create when the CLI sent one
// field the deployed validator lacked (2026-10-23): the whole call, the api
// token and the value being saved included.
test("an argument refusal answers 400 with its sentence, never the arguments, and logs the same", () => {
  const token = "cc_" + "t".repeat(40);
  const value = "zz-FAKE-VALUE-123";
  const thrown = new Error(
    `ArgumentValidationError: Object contains extra field \`from_a_newer_cli\` that is not in the validator.\n\n`
    + `Object: {api_token: "${token}", kind: "key", name: "zz-x", payload: {value: "${value}"}, personal: true, from_a_newer_cli: 1.0}\n`
    + `Validator: v.object({api_token: v.optional(v.string()), kind: v.string(), name: v.string(), payload: v.any()})`,
  );
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const reply = cliErrorReply(thrown, "/cli/vault/create");
  const logged = JSON.stringify(warn.mock.calls);
  warn.mockRestore();
  expect(reply.status).toBe(400);
  const text = JSON.stringify(reply.body);
  expect(text).toContain("extra field `from_a_newer_cli`");
  for (const out of [text, logged]) {
    expect(out).not.toContain(value);
    expect(out).not.toContain(token);
  }
});

test("a ConvexError keeps its code and status; any other throw passes its message", () => {
  expect(cliErrorReply(Object.assign(new Error("x"), { data: { code: "NOT_FOUND", message: "No such task" } }), "/cli/x")).toEqual({ status: 404, body: { code: "NOT_FOUND", message: "No such task", error: "No such task" } });
  expect(cliErrorReply(new Error("Unauthorized: sign in"), "/cli/x")).toEqual({ status: 401, body: { error: "Unauthorized: sign in" } });
  expect(cliErrorReply(new Error("boom"), "/cli/x")).toEqual({ status: 500, body: { error: "boom" } });
});
