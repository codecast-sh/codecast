import { describe, expect, test } from "bun:test";
import { commandsSession } from "./inboxProjection";

// THE COMMAND RULE: the server's requireSessionCommandTarget and the client's
// Needs You filing and answer/resume controls all read this one predicate.
describe("commandsSession", () => {
  const id = (s: string) => ({ toString: () => s });
  test("the runner or the second-party owner may command; a teammate or co-owner may not", () => {
    expect(commandsSession({ user_id: "runner" }, "runner")).toBe(true);
    expect(commandsSession({ user_id: "runner", owner_user_id: "owner" }, "owner")).toBe(true);
    expect(commandsSession({ user_id: id("runner") }, id("runner"))).toBe(true);
    expect(commandsSession({ user_id: "runner" }, "teammate")).toBe(false);
    expect(commandsSession({ user_id: "runner", owner_user_id: "runner" }, "teammate")).toBe(false);
  });
  test("an unknown viewer commands nothing", () => {
    expect(commandsSession({ user_id: "runner" }, null)).toBe(false);
    expect(commandsSession({ user_id: "" }, "")).toBe(false);
  });
});
