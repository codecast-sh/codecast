import { expect, test } from "bun:test";
import { chooseClaudeBackend, sdkBackendRefusal } from "./select.js";

test("a start's own choice wins, then the daemon env, then config; tmux by default", () => {
  expect(chooseClaudeBackend("tmux", { CODECAST_CLAUDE_BACKEND: "sdk" }, "sdk")).toBe("tmux");
  expect(chooseClaudeBackend(undefined, { CODECAST_CLAUDE_BACKEND: "sdk" }, "tmux")).toBe("sdk");
  expect(chooseClaudeBackend(undefined, {}, "sdk")).toBe("sdk");
  expect(chooseClaudeBackend("bogus", {}, undefined)).toBe("tmux");
});

test("the version gate refuses an old claude, and a failed read is asked again", async () => {
  const bin = `/nonexistent/claude-${crypto.randomUUID()}`;
  let calls = 0;
  const failing = async () => { calls++; throw new Error("timed out"); };
  expect(await sdkBackendRefusal(bin, failing)).toContain("could not read");
  expect(await sdkBackendRefusal(bin, async () => "2.1.319 (Claude Code)")).toBeNull();
  expect(calls).toBe(1);
  const old = `/nonexistent/claude-${crypto.randomUUID()}`;
  expect(await sdkBackendRefusal(old, async () => "2.1.100 (Claude Code)")).toContain("older than");
});
