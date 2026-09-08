// The warm worktree pool only helps if the daemon actually runs it, and the
// wiring is four lines spread across a 25000-line file: a maintainer started
// per repo that creates worktrees, resumed at boot, stopped at shutdown. Each
// of them is easy to drop in a merge and impossible to notice afterwards — a
// dead pool looks exactly like a cold create. This guard reads the source
// rather than booting the daemon, which no unit test can afford.
//
// The loop-budget guard (daemon.loopBudget.guard.test.ts) covers the other
// half: that nothing in these paths blocks the event loop.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { functionBlock, sliceBetween } from "./test-helpers/sourceRegion.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const daemon = fs.readFileSync(path.join(SRC, "daemon.ts"), "utf8");

describe("daemon warm worktree pool wiring", () => {
  test("a repo that creates a worktree gets a maintainer", () => {
    const block = functionBlock(daemon, "createWorktree");
    expect(block.text).toContain("registerWorktreePool(repoRoot)");
  });

  test("registerWorktreePool only arms repos with a workspace manifest", () => {
    const block = functionBlock(daemon, "registerWorktreePool");
    expect(block.text).toContain(".codecast/workspace.toml");
    expect(block.text).toContain("startPoolMaintainer");
    // One maintainer per repo, whatever the create rate.
    expect(block.text).toContain("worktreePoolMaintainers.has(repoRoot)");
    // Remembered, so a restart resumes the pools instead of losing them.
    expect(block.text).toContain("worktreePoolRepos");
  });

  test("boot resumes the pools and shutdown stops them", () => {
    const boot = sliceBetween(daemon, "const versionCheckInterval = startVersionChecker(", "const cursorWatcher = new CursorWatcher(", 0);
    expect(boot.text).toContain("startWorktreePools()");
    const shutdown = sliceBetween(daemon, "clearInterval(statusCleanupInterval);", "stopHookServer();", 0);
    expect(shutdown.text).toContain("await stopWorktreePools()");
  });

  test("stopWorktreePools clears the registry so a restart cannot double-run one", () => {
    const block = functionBlock(daemon, "stopWorktreePools");
    expect(block.text).toContain("worktreePoolMaintainers.clear()");
  });
});
