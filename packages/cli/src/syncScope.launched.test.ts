import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchScopeRefusal, markLaunched, resetLaunchedSessionsMemo, transcriptScopeRefusal, wasLaunched } from "./syncScope.js";

let dir: string;
const prevDir = process.env.CODECAST_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "launched-"));
  process.env.CODECAST_DIR = dir;
  resetLaunchedSessionsMemo();
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prevDir;
  resetLaunchedSessionsMemo();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The rentamac report (2026-11-18): a person syncing only ~/git/littlebird
// started sessions from codecast in their home folder. The agent ran and got
// every message, but the sync scope refused its transcript as a "non-selected
// project", so the conversation sat at 0 messages forever.
const selectedLittlebird = { sync_mode: "selected" as const, sync_projects: ["/Users/rentamac/git/littlebird"] };

test("a session codecast launched syncs outside the selected folders", () => {
  expect(transcriptScopeRefusal("/Users/rentamac", selectedLittlebird)).toContain("non-selected");
  expect(transcriptScopeRefusal("/Users/rentamac", selectedLittlebird, true)).toBeNull();
  expect(transcriptScopeRefusal(null, selectedLittlebird, true)).toBeNull();
});

test("an explicit exclusion still holds a launched session back, and the launch says so", () => {
  const excluded = { ...selectedLittlebird, excluded_paths: "/Users/rentamac/private" };
  expect(transcriptScopeRefusal("/Users/rentamac/private/x", excluded, true)).toContain("excluded");
  expect(launchScopeRefusal("/Users/rentamac/private/x", excluded)).toContain("excluded");
  expect(launchScopeRefusal("/Users/rentamac", excluded)).toBeNull();
  const allButClient = { sync_mode: "all" as const, sync_excluded: ["/w/client"] };
  expect(launchScopeRefusal("/w/client/app", allButClient)).toContain("excluded");
  expect(launchScopeRefusal("/w/other", allButClient)).toBeNull();
});

test("a launch is remembered by session and by conversation, across a daemon restart", () => {
  markLaunched({ conversationId: "conv1", sessionId: "s1" });
  markLaunched({ conversationId: "conv2" });
  resetLaunchedSessionsMemo();
  expect(wasLaunched("s1")).toBe(true);
  expect(wasLaunched("s2", "conv2")).toBe(true);
  expect(wasLaunched("s2", "conv3")).toBe(false);
  expect(wasLaunched(undefined)).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "launched-sessions.json"), "utf8")).sessions.s1).toBeNumber();
});

test("the daemon's transcript gate counts a subagent of a launched session as launched", async () => {
  const { launchedTranscript } = await import("./daemon.js");
  markLaunched({ conversationId: "convP", sessionId: "parent-uuid" });
  expect(launchedTranscript("parent-uuid", "/h/.claude/projects/-Users-x/parent-uuid.jsonl")).toBe(true);
  expect(launchedTranscript("agent-1", "/h/.claude/projects/-Users-x/parent-uuid/subagents/agent-1.jsonl")).toBe(true);
  expect(launchedTranscript("other", "/h/.claude/projects/-Users-x/other.jsonl")).toBe(false);
});
