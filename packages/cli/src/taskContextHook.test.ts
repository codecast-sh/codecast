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

function writePulse(sessionId: string, pulse: Record<string, unknown>) {
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

  test("a compaction with no task pulse still asks: the server may hold the session's task", () => {
    expect(runScript(TASK_CONTEXT_HOOK, { session_id: "unbound", source: "compact" })).toStartWith("ARGS:_task-context\n");
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
      const log = path.join(codecastDir(), "task-context.log");
      expect(fs.readFileSync(log, "utf-8")).toMatch(/Z s-5 codecast _task-context exited 1\n$/);
      // Capped as the CLI caps it: past 64 KB the log starts over.
      fs.writeFileSync(log, "x".repeat(70_000));
      runScript(TASK_CONTEXT_HOOK, { session_id: "s-5", source: "compact" });
      expect(fs.readFileSync(log, "utf-8")).toMatch(/^\S+Z s-5 codecast _task-context exited 1\n$/);
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

  async function withDir<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = codecastDir();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = prev;
    }
  }

  test("reads once, only on compact or resume, with the pulse's task and plan when there is one", () => withDir(async () => {
    writePulse("s-4", { task: "ct-4", plan: "pl-9" });
    const reads: unknown[] = [];
    const read = async (body: unknown) => { reads.push(body); return context; };

    expect(await taskContextFor({ session_id: "s-4", source: "startup" }, read)).toBeNull();
    expect(await taskContextFor({ session_id: "s-4", source: "compact", cursor_version: "1.0" }, read)).toBeNull();
    expect(reads).toEqual([]);

    const block = await taskContextFor({ session_id: "s-4", source: "compact" }, read);
    expect(reads).toEqual([{ short_id: "ct-4", plan_id: "pl-9", session_id: "s-4" }]);
    expect(block).toContain("You are bound to task ct-4: Ship it [in_progress, medium]");

    // A session spawned for a task has no pulse: the server finds its task from the session.
    expect(await taskContextFor({ session_id: "spawned", source: "compact" }, read)).toContain("task ct-4");
    expect(reads.at(-1)).toEqual({ session_id: "spawned" });

    // A pulse from a start says so; one from a create does not, so the server
    // never tells a session it lost a task it only filed.
    writePulse("s-5", { task: "ct-5", started: true });
    await taskContextFor({ session_id: "s-5", source: "resume" }, read);
    expect(reads.at(-1)).toEqual({ short_id: "ct-5", started: true, session_id: "s-5" });

    // Grok's camelCase envelope; a server that answers with nothing prints nothing.
    expect(await taskContextFor({ sessionId: "s-4", source: "resume" }, async () => null)).toBeNull();
  }));

  test("a time wait is named absolute, in the block and in the cast state line it tells the agent to copy", () => withDir(async () => {
    writePulse("s-7", { task: "ct-7", started: true });
    const at = Date.UTC(2026, 9, 9, 3, 23);
    const read = async (): Promise<TaskResumeContext> => ({
      ...context,
      task: { ...context.task, short_id: "ct-7", status: "open" },
      blockers: [{ id: "w1k2l3m4n5", kind: "time", at, state: "waiting", created_at: at - 3_600_000, created_by: "u1" }],
    });
    const block = (await taskContextFor({ session_id: "s-7", source: "compact" }, read, at - 3_600_000))!;
    // The date, the year and the zone, the way cast task context and the
    // stored history name the moment — never a bare local-clock "03:23".
    const absolute = /\w{3} \d{1,2}, 2026 \d{2}:\d{2} \S+/;
    expect(block).toMatch(new RegExp(`- until ${absolute.source}`));
    expect(block).toMatch(new RegExp(`cast state --status dormant "Waiting until ${absolute.source}"`));
    expect(block).not.toMatch(/until \d{2}:\d{2}["\n]/);
  }));

  test("a read that fails still names the pulse's task; without one it stays silent", () => withDir(async () => {
    writePulse("s-6", { task: "ct-6", plan: "pl-2" });
    const fail = async (): Promise<TaskResumeContext | null> => { throw new Error("no answer in 4000ms"); };
    const block = await taskContextFor({ session_id: "s-6", source: "compact" }, fail);
    expect(block).toContain("This session's last task was ct-6 (plan pl-2).");
    expect(block).toContain("run cast task context ct-6");
    expect(await taskContextFor({ session_id: "no-pulse", source: "compact" }, fail)).toBeNull();
  }));
});
