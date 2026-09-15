import { test, expect, describe } from "bun:test";
import { isOnThreadRoute } from "./openSessionAtMessage";

describe("isOnThreadRoute", () => {
  test("inbox and conversation pages are the thread", () => {
    expect(isOnThreadRoute("/inbox")).toBe(true);
    expect(isOnThreadRoute("/inbox?s=abc")).toBe(true);
    expect(isOnThreadRoute("/conversation/jx84qtvpbmmrmwcjqmhzawejsx8bq9gm")).toBe(true);
  });

  test("the decision page is not the thread", () => {
    expect(isOnThreadRoute("/decisions/sd-1")).toBe(false);
    expect(isOnThreadRoute("/questions")).toBe(false);
    expect(isOnThreadRoute("/tasks/ct-1")).toBe(false);
  });
});
