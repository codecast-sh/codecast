import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProjectAllowedToSync, transcriptScopeRefusal } from "./syncScope.js";

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

test("a transcript placed by workspace syncs only where both the exclusions and the selection allow it", () => {
  const selected = { sync_mode: "selected" as const, sync_projects: ["/a"], excluded_paths: "/a/private" };
  expect(transcriptScopeRefusal("/a/app", selected)).toBeNull();
  expect(transcriptScopeRefusal("/a/private/app", selected)).toContain("excluded");
  expect(transcriptScopeRefusal("/b/app", selected)).toContain("non-selected");
  expect(transcriptScopeRefusal(null, selected)).toContain("unknown");
  expect(transcriptScopeRefusal(null, { sync_mode: "all" })).toBeNull();
});

// One person's sync lists cover all their machines: a new Mac whose account is
// named differently (rentamac vs david) keeps the projects at the same place
// under home, and must not need every folder chosen again.
test("a chosen or excluded folder decides the same place under home on the person's other machines", () => {
  const chosen = { sync_mode: "selected" as const, sync_projects: ["/Users/david/git/littlebird"] };
  expect(isProjectAllowedToSync("/Users/rentamac/git/littlebird", chosen)).toBe(true);
  expect(isProjectAllowedToSync("/home/ubuntu/git/littlebird/backend", chosen)).toBe(true);
  expect(isProjectAllowedToSync("/Users/rentamac/git/littlebird2", chosen)).toBe(false);
  expect(isProjectAllowedToSync("/Users/rentamac", chosen)).toBe(false);
  expect(isProjectAllowedToSync("/opt/git/littlebird", chosen)).toBe(false);
  const excluded = { sync_mode: "all" as const, sync_excluded: ["/Users/david/clients"] };
  expect(isProjectAllowedToSync("/Users/rentamac/clients/acme", excluded)).toBe(false);
  expect(isProjectAllowedToSync("/Users/rentamac/git/app", excluded)).toBe(true);
});
