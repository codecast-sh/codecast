// Run: bun test lib/__tests__/setupPrompt.test.ts
import { describe, expect, test } from "bun:test";
import { setupPromptMessage } from "../setupPrompt";

describe("setupPromptMessage", () => {
  test("no CLI asks for the install, with or without sessions", () => {
    expect(setupPromptMessage(false, false)).toMatch(/^Install the CLI/);
    expect(setupPromptMessage(false, true)).toMatch(/^Install the CLI/);
  });
  test("a CLI with nothing synced asks for the daemon", () => {
    expect(setupPromptMessage(true, false)).toMatch(/^Start the daemon/);
  });
  test("a CLI with sessions asks for nothing", () => {
    expect(setupPromptMessage(true, true)).toBeNull();
  });
});
