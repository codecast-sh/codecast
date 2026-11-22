import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { isSubagentTranscriptPath } from "./daemon.js";

// A Claude subagent runs inside its parent's process, in the parent's cwd.
// Strategy C (cwd match) found exactly one unclaimed claude there, the parent,
// and the daemon registered that pid and tmux pane as the subagent's own
// (observed 2026-11-22: agent-aplacement-2 registered with its lead's pid 51356).

const projects = "/Users/x/.claude/projects/-Users-x-code-app";
const PARENT = "60f7f0f9-b929-4a3f-a150-7c419b517518";

describe("isSubagentTranscriptPath", () => {
  test("a Task subagent's transcript has no process of its own", () => {
    expect(isSubagentTranscriptPath(`${projects}/${PARENT}/subagents/agent-a92bb00c0ffee.jsonl`)).toBe(true);
  });

  test("a workflow agent's transcript has no process of its own", () => {
    expect(isSubagentTranscriptPath(`${projects}/${PARENT}/subagents/workflows/run-1/agent-a1.jsonl`)).toBe(true);
  });

  test("a top-level session owns its process", () => {
    expect(isSubagentTranscriptPath(`${projects}/${PARENT}.jsonl`)).toBe(false);
  });

  test("no transcript on disk proves nothing", () => {
    expect(isSubagentTranscriptPath(null)).toBe(false);
    expect(isSubagentTranscriptPath(undefined)).toBe(false);
  });
});

describe("the guard is wired into every place a subagent could take its parent's pid", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf-8");
  const body = (start: string) => {
    const at = src.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n}\n", at));
  };

  test("the Claude sync pass never registers a process for a subagent", () => {
    const calls = src.split("\n").filter((l) => l.includes(`tryRegisterSessionProcess(sessionId, "claude")`));
    expect(calls).toEqual([`    if (!subagentTranscript) tryRegisterSessionProcess(sessionId, "claude");`]);
  });

  test("Strategy C never guesses a subagent's process from its cwd", () => {
    const impl = body("async function findSessionProcessImpl(");
    const strategyC = impl.slice(impl.indexOf("// Strategy C"));
    expect(strategyC).toMatch(/if \(jsonlPath && !isSubagentTranscriptPath\(jsonlPath\)\) \{/);
  });

  test("Strategy 0 drops a daemon-written registration for a subagent before trusting its pid", () => {
    const impl = body("async function findSessionProcessImpl(");
    const strategy0 = impl.slice(impl.indexOf("// Strategy 0"), impl.indexOf("// Strategy A"));
    const drop = strategy0.indexOf("if (!isHookRegistration(reg) && isSubagentTranscriptPath(findSessionJsonlPath(sessionId))) {");
    const use = strategy0.indexOf("} else if (checkPs.trim()) {");
    expect(drop).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(drop);
    expect(strategy0.slice(drop, use)).toContain("fs.unlinkSync(registryFile)");
  });
});
