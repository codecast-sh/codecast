import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { acquireFailureLine, castResult } from "./flowAcquire.js";

test("a child cast that never started gives the spawn's reason, not an empty line (ct-98253)", () => {
  const r = castResult(spawnSync("cast-not-on-this-path", ["ws", "acquire", "run-ct-1"], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } }));
  expect(r.code).toBe(1);
  const line = acquireFailureLine("run-ct-1", r.out, r.err);
  expect(line).toStartWith("Could not make the worktree for the change: ");
  expect(line).toContain("cast-not-on-this-path");
});

test("a broken worktree is named with its failed checks and the way to repair it, never as raw JSON", () => {
  const out = JSON.stringify({ name: "change-ct-9", state: "broken", contract: { ok: false, failures: [{ name: "install", reason: "bun install exited 1" }], warnings: [] } });
  const line = acquireFailureLine("change-ct-9", out, "");
  expect(line).toBe("The worktree change-ct-9 for the change is broken (install: bun install exited 1). Repair it with cast ws heal change-ct-9, or remove it with cast ws destroy change-ct-9, then run this again.");
  expect(line).not.toContain("{");
  expect(acquireFailureLine("w", "", "acquire failed: branch x is checked out elsewhere")).toBe("Could not make the worktree for the change: acquire failed: branch x is checked out elsewhere");
});
