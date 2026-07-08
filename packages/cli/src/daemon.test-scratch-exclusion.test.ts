// Regression guard for the phantom "cc-inject-clear-*" inbox conversations.
//
// daemon.inject-clear.test.ts drives a REAL claude under a throwaway project
// dir. Its transcript lands in ~/.claude/projects like any other, so the running
// daemon would sync it as a real conversation — leaking a test session into the
// inbox (root-caused 2026-06-03). The fix: the daemon's universal sync gate,
// isProjectAllowedToSync, refuses any project path carrying the scratch marker,
// regardless of the user's sync_mode/excluded_paths config. These tests pin that
// contract so the gate can't silently regress to syncing test scratch again.

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProjectAllowedToSync,
  isTestScratchPath,
  TEST_SCRATCH_DIRNAME,
} from "./daemon.js";

const scratchProject = path.join(
  os.tmpdir(),
  TEST_SCRATCH_DIRNAME,
  "inject-clear-12345-1780442401715",
);

describe("test-scratch sync exclusion", () => {
  test("scratch path is recognized regardless of how it was resolved", () => {
    // Exact recorded-cwd resolution.
    expect(isTestScratchPath(scratchProject)).toBe(true);
    // Lossy dir-name slug decode collapses every "/" and "." to "-"; the marker
    // is a single dot/hyphen-free token so it survives that mangling too.
    expect(isTestScratchPath(scratchProject.replace(/[/.]/g, "-"))).toBe(true);
    // Real projects are untouched.
    expect(isTestScratchPath("/Users/ashot/src/codecast")).toBe(false);
    expect(isTestScratchPath("")).toBe(false);
  });

  test("scratch project is never synced, even under sync_mode:all", () => {
    // sync_mode:"all" (the default) otherwise allows everything through.
    expect(isProjectAllowedToSync(scratchProject, { sync_mode: "all" } as any)).toBe(false);
    // Undefined sync_mode also defaults to "all" — still rejected.
    expect(isProjectAllowedToSync(scratchProject, {} as any)).toBe(false);
  });

  test("real projects still sync under sync_mode:all", () => {
    expect(isProjectAllowedToSync("/Users/ashot/src/codecast", { sync_mode: "all" } as any)).toBe(true);
  });
});
