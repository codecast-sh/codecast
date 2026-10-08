import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskResumeContext } from "@codecast/shared/tasks";
import { TASK_CONTEXT_HOOK, TASK_CONTEXT_HOOK_CODEX, taskContextFor } from "./taskContextHook.js";

let home: string;
let bin: string;
const codecastDir = () => path.join(home, ".codecast");

function writePulse(sessionId: string, pulse: Record<string, string>) {
  fs.mkdirSync(path.join(codecastDir(), "task-pulse"), { recursive: true });
  fs.writeFileSync(path.join(codecastDir(), "task-pulse", `${sessionId}.json`), JSON.stringify(pulse));
}

function runScript(script: string, payload: Record<string, unknown>): string {
  const file = path.join(home, "hook.sh");
  fs.writeFileSync(file, script, { mode: 0o755 });
  return execFileSync("bash", [file], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, CODECAST_DIR: codecastDir(), PATH: `${bin}:/usr/bin:/bin` },
  }).toString();
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-task-context-"));
  fs.mkdirSync(codecastDir(), { recursive: true });
  fs.writeFileSync(path.join(codecastDir(), "config.json"), JSON.stringify({ work_enabled: true }, null, 2));
  bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // Stands in for the CLI: prints the argv it was given and the payload it read.
  fs.writeFileSync(path.join(bin, "codecast"), "#!/bin/bash\necho \"ARGS:$*\"\ncat\n", { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("task-context.sh gates before a node boot", () => {
  test("a startup or clear never reaches the CLI", () => {
    writePulse("s-1", { task: "ct-1" });
    for (const source of ["startup", "clear", ""]) {
      expect(runScript(TASK_CONTEXT_HOOK, { session_id: "s-1", source, hook_event_name: "SessionStart" })).toBe("");
    }
  });

  test("a compaction with no task pulse is silent", () => {
    expect(runScript(TASK_CONTEXT_HOOK, { session_id: "unbound", source: "compact" })).toBe("");
  });

  test("a compaction or resume of a bound session hands the payload to the CLI", () => {
    writePulse("s-2", { task: "ct-2" });
    for (const source of ["compact", "resume"]) {
      const payload = { session_id: "s-2", source, hook_event_name: "SessionStart" };
      expect(runScript(TASK_CONTEXT_HOOK, payload)).toBe(`ARGS:_task-context\n${JSON.stringify(payload)}\n`);
    }
    expect(runScript(TASK_CONTEXT_HOOK_CODEX, { session_id: "s-2", source: "compact" })).toStartWith("ARGS:_task-context --client codex\n");
  });

  test("a CLI that fails (an older one without the verb) leaves the session start clean", () => {
    writePulse("s-5", { task: "ct-5" });
    const stub = path.join(bin, "codecast");
    const ok = fs.readFileSync(stub, "utf-8");
    fs.writeFileSync(stub, "#!/bin/bash\necho \"error: unknown command '_task-context'\" >&2\nexit 1\n", { mode: 0o755 });
    try {
      expect(runScript(TASK_CONTEXT_HOOK, { session_id: "s-5", source: "compact" })).toBe("");
    } finally {
      fs.writeFileSync(stub, ok, { mode: 0o755 });
    }
  });

  test("silent while Tasks & Plans is off, and for an unsafe session id", () => {
    writePulse("s-3", { task: "ct-3" });
    fs.writeFileSync(path.join(codecastDir(), "config.json"), JSON.stringify({ work_enabled: false }));
    expect(runScript(TASK_CONTEXT_HOOK, { session_id: "s-3", source: "compact" })).toBe("");
    fs.writeFileSync(path.join(codecastDir(), "config.json"), JSON.stringify({ work_enabled: true }));
    expect(runScript(TASK_CONTEXT_HOOK, { session_id: "../s-3", source: "compact" })).toBe("");
  });
});

describe("taskContextFor", () => {
  const context: TaskResumeContext = {
    task: { short_id: "ct-4", title: "Ship it", status: "in_progress", priority: "medium" },
    blockers: [],
    progress: null,
    plan: null,
  };

  test("reads the bound task and plan once, only on compact or resume", async () => {
    const prev = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = codecastDir();
    try {
      writePulse("s-4", { task: "ct-4", plan: "pl-9" });
      const reads: unknown[] = [];
      const read = async (body: unknown) => { reads.push(body); return context; };

      expect(await taskContextFor({ session_id: "s-4", source: "startup" }, read)).toBeNull();
      expect(await taskContextFor({ session_id: "s-4", source: "compact", cursor_version: "1.0" }, read)).toBeNull();
      expect(await taskContextFor({ session_id: "nobody", source: "compact" }, read)).toBeNull();
      expect(reads).toEqual([]);

      const block = await taskContextFor({ session_id: "s-4", source: "compact" }, read);
      expect(reads).toEqual([{ short_id: "ct-4", plan_id: "pl-9" }]);
      expect(block).toContain("You are bound to task ct-4: Ship it [in_progress, medium]");

      // Grok's camelCase envelope; a failed read prints nothing.
      expect(await taskContextFor({ sessionId: "s-4", source: "resume" }, async () => null)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = prev;
    }
  });
});
