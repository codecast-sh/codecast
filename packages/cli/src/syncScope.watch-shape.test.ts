import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeProjectsDir, isClaudeTranscriptOutOfWatchScope } from "./syncScope.js";
import { isTranscriptFileInSyncScope } from "./reconciliation.js";

// The startup/wake sweeps and reconciliation walk ~/.claude/projects with a bare
// ".jsonl" rule, while the live watcher applies watchFilter. The gap synced a
// dynamic-workflow run's journal.jsonl as a subagent conversation and left a
// ledger row `cast status` reported as a stuck sync forever (2026-09-03).
// Every gate now shares the watcher's shape rule.

const uuid = "281e2ac7-683f-4812-94b7-21a25c8a730c";
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "watch-shape-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function write(rel: string, body = '{"type":"user","cwd":"/tmp/x","message":{"role":"user","content":"hi"}}\n'): string {
  const p = path.join(claudeProjectsDir(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

test("the workflow run journal is out of watch scope; transcripts around it are in", () => {
  const journal = write(`-proj/${uuid}/subagents/workflows/wf_abc/journal.jsonl`, '{"agent":"a1","event":"started"}\n');
  const workflowAgent = write(`-proj/${uuid}/subagents/workflows/wf_abc/agent-a1b2c3.jsonl`);
  const taskSubagent = write(`-proj/${uuid}/subagents/agent-deadbeef.jsonl`);
  const session = write(`-proj/${uuid}.jsonl`);

  expect(isClaudeTranscriptOutOfWatchScope(journal)).toBe(true);
  expect(isClaudeTranscriptOutOfWatchScope(workflowAgent)).toBe(false);
  expect(isClaudeTranscriptOutOfWatchScope(taskSubagent)).toBe(false);
  expect(isClaudeTranscriptOutOfWatchScope(session)).toBe(false);
});

test("paths outside ~/.claude/projects are never refused by the claude rule", () => {
  expect(isClaudeTranscriptOutOfWatchScope(path.join(home, ".codex", "sessions", "2026", "rollout-x.jsonl"))).toBe(false);
});

test("isTranscriptFileInSyncScope rejects the journal even with no config", () => {
  const journal = write(`-proj/${uuid}/subagents/workflows/wf_abc/journal.jsonl`, '{"agent":"a1"}\n');
  const session = write(`-proj/${uuid}.jsonl`);
  expect(isTranscriptFileInSyncScope(journal)).toBe(false);
  expect(isTranscriptFileInSyncScope(session)).toBe(true);
});
