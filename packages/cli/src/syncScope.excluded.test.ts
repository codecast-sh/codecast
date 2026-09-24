import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProjectAllowedToSync } from "./syncScope.js";

test("with everything syncing, excluded folders and the folders inside them do not upload", () => {
  const config = { sync_mode: "all" as const, sync_excluded: ["/home/ada/src/client"] };
  expect(isProjectAllowedToSync("/home/ada/src/app", config)).toBe(true);
  expect(isProjectAllowedToSync("/home/ada/src/client", config)).toBe(false);
  expect(isProjectAllowedToSync("/home/ada/src/client/sub", config)).toBe(false);
  expect(isProjectAllowedToSync("/home/ada/src/client-two", config)).toBe(true);
  expect(isProjectAllowedToSync("/home/ada/src/client", { sync_mode: "all" as const })).toBe(true);
});

test("an excluded checkout keeps its worktrees outside it from uploading too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-excl-"));
  const checkout = path.join(root, "repo");
  const worktree = path.join(root, "wt");
  fs.mkdirSync(path.join(checkout, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(checkout, ".git", "worktrees", "wt")}\n`);
  fs.writeFileSync(path.join(checkout, ".git", "worktrees", "wt", "commondir"), "../..\n");
  try {
    expect(isProjectAllowedToSync(worktree, { sync_mode: "all", sync_excluded: [checkout] })).toBe(false);
    expect(isProjectAllowedToSync(worktree, { sync_mode: "all", sync_excluded: [] })).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exclusions do not apply to chosen folders mode, which lists what uploads", () => {
  expect(isProjectAllowedToSync("/a/b", { sync_mode: "selected", sync_projects: ["/a"], sync_excluded: ["/a/b"] })).toBe(true);
});
