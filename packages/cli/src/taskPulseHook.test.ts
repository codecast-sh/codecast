import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TASK_PULSE_HOOK } from "./taskPulseHook.js";

let home: string;
let hookFile: string;
let bin: string;

function run(sessionId: string): string {
  return execFileSync("bash", [hookFile], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  }).toString();
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-task-pulse-"));
  hookFile = path.join(home, "task-pulse.sh");
  fs.writeFileSync(hookFile, TASK_PULSE_HOOK, { mode: 0o755 });
  bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\necho PYTHON_CALLED >&2\nexit 1\n", { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("task-pulse hook", () => {
  test("no pulse file is a silent no-op, without python3", () => {
    expect(run("no-pulse")).toBe("");
  });

  test("emits every 8 turns with the bound task and plan", () => {
    const id = "pulse-1";
    fs.mkdirSync(path.join(home, ".codecast", "task-pulse"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codecast", "task-pulse", `${id}.json`),
      JSON.stringify({ task: "ct-1", plan: "pl-2" }),
    );
    for (let i = 0; i < 7; i++) expect(run(id)).toBe("");
    expect(run(id)).toBe("<task-reminder>You are working on task ct-1, plan pl-2. Check progress against acceptance criteria.</task-reminder>\n");
  });
});
