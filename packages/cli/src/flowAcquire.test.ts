import { expect, test } from "bun:test";
import { acquireFailureLine } from "./flowCommand.js";

test("a broken worktree is named with its failed checks and the way to repair it, never as raw JSON", () => {
  const out = JSON.stringify({ name: "change-ct-9", state: "broken", contract: { ok: false, failures: [{ name: "install", reason: "bun install exited 1" }], warnings: [] } });
  const line = acquireFailureLine("change-ct-9", out, "");
  expect(line).toBe("The worktree change-ct-9 for the change is broken (install: bun install exited 1). Repair it with cast ws heal change-ct-9, or remove it with cast ws destroy change-ct-9, then run this again.");
  expect(line).not.toContain("{");
  expect(acquireFailureLine("w", "", "acquire failed: branch x is checked out elsewhere")).toBe("Could not make the worktree for the change: acquire failed: branch x is checked out elsewhere");
});
