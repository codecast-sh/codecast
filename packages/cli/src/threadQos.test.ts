import { describe, expect, test } from "bun:test";
import { raiseThreadToInteractiveQos } from "./threadQos.js";

describe("raiseThreadToInteractiveQos", () => {
  test("raises the thread on macOS and is a no-op elsewhere", () => {
    expect(raiseThreadToInteractiveQos()).toBe(process.platform === "darwin");
  });
});
