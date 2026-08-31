import { describe, expect, test } from "bun:test";
import { parseSwitchAgentArg } from "./switchCommand.ts";

describe("parseSwitchAgentArg", () => {
  test("accepts daemon and convex spellings", () => {
    expect(parseSwitchAgentArg("claude")).toBe("claude_code");
    expect(parseSwitchAgentArg("claude_code")).toBe("claude_code");
    expect(parseSwitchAgentArg("Codex")).toBe("codex");
    expect(parseSwitchAgentArg("grok")).toBe("grok");
  });

  test("rejects unknown names", () => {
    expect(() => parseSwitchAgentArg("not-an-agent")).toThrow(/Unknown agent/);
  });
});
