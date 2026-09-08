// Regression guard for phantom test-run conversations in the user's inbox.
//
// Two suites drive an agent under a throwaway project dir: daemon.inject-clear
// runs a REAL claude under a `codecasttestscratch` dir, and messagingHarness
// runs the fake-claude shim under a `codecast-test-cwd-` dir. Both transcripts
// land in ~/.claude/projects like any other, so anything that syncs them puts a
// test session in the inbox — root-caused twice, on 2026-06-03 (scratch, live
// watcher) and 2026-09-07 (harness, startup sweep).
//
// The rule is one gate, isTestArtifactPath, that every walker consults: the
// live watcher via isTestProjectDir, the startup/wake sweep and reconciliation
// via isTranscriptFileInSyncScope, the sync loop via isProjectAllowedToSync.
// These tests pin that contract so no gate can drift out of it again.

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProjectAllowedToSync,
  isTestArtifactPath,
  TEST_SCRATCH_DIRNAME,
} from "./daemon.js";
import { isTestProjectDir } from "./syncScope.js";
import { isTranscriptFileInSyncScope } from "./reconciliation.js";

const scratchProject = path.join(
  os.tmpdir(),
  TEST_SCRATCH_DIRNAME,
  "inject-clear-12345-1780442401715",
);
const harnessProject = path.join(os.tmpdir(), "codecast-test-cwd-yy3bYH");
const shimProject = path.join(os.tmpdir(), "codecast-fake-claude-abc123");

// How the daemon spells a project dir under ~/.claude/projects: every "/" and
// "." of the cwd becomes "-".
const encodeProjectDir = (projectPath: string) => projectPath.replace(/[/.]/g, "-");
// And the lossy way back, where every "-" reads as a "/".
const decodeProjectDir = (dirName: string) => dirName.replace(/-/g, "/");

describe("test-run sync exclusion", () => {
  test("every marker is recognized in every spelling of the path", () => {
    for (const project of [scratchProject, harnessProject, shimProject]) {
      // Exact recorded-cwd resolution.
      expect(isTestArtifactPath(project)).toBe(true);
      // The encoded dir name under ~/.claude/projects.
      expect(isTestArtifactPath(encodeProjectDir(project))).toBe(true);
      // And its lossy decode back to a path.
      expect(isTestArtifactPath(decodeProjectDir(encodeProjectDir(project)))).toBe(true);
    }
    // Real projects are untouched.
    expect(isTestArtifactPath("/Users/ashot/src/codecast")).toBe(false);
    expect(isTestArtifactPath("")).toBe(false);
  });

  test("a test project is never synced, even under sync_mode:all", () => {
    for (const project of [scratchProject, harnessProject, shimProject]) {
      // sync_mode:"all" (the default) otherwise allows everything through.
      expect(isProjectAllowedToSync(project, { sync_mode: "all" } as any)).toBe(false);
      // Undefined sync_mode also defaults to "all" — still rejected.
      expect(isProjectAllowedToSync(project, {} as any)).toBe(false);
    }
  });

  test("the live watcher refuses the same dirs", () => {
    for (const project of [scratchProject, harnessProject, shimProject]) {
      expect(isTestProjectDir(encodeProjectDir(project))).toBe(true);
    }
    expect(isTestProjectDir("-Users-ashot-src-codecast")).toBe(false);
  });

  test("the startup/wake sweep refuses them from the file path alone", () => {
    // The sweep is the gate that leaked 39 harness sessions into the inbox: the
    // watcher skipped these files, so they never got a ledger position, and
    // every sweep then read them as unsynced and uploaded them. It gates on the
    // raw transcript path, before any cwd is read.
    const uuid = "af6d736b-6c0f-4af9-bd24-30772ae4c87a";
    const home = process.env.HOME || "";
    for (const project of [scratchProject, harnessProject, shimProject]) {
      const transcript = path.join(
        home, ".claude", "projects", encodeProjectDir(project), `${uuid}.jsonl`,
      );
      expect(isTranscriptFileInSyncScope(transcript)).toBe(false);
    }
  });

  test("real projects still sync under sync_mode:all", () => {
    expect(isProjectAllowedToSync("/Users/ashot/src/codecast", { sync_mode: "all" } as any)).toBe(true);
  });
});
