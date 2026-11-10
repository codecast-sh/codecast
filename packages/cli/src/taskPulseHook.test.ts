import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOOK_FEATURE_ON, HOOK_FIELDS_AWK, HOOK_STATE_DIR } from "./hookJson.js";
import { TASK_PULSE_JOB } from "./taskPulseHook.js";

let home: string;
let hookFile: string;
let bin: string;

// The job has no script of its own (it runs inside codecast-prompt.sh), so the
// test gives it the three things that script provides: the state directory,
// feature_on and SESSION_ID. HOOK_task stands for the envelope fields the jobs
// after this one read; the last line prints it when asked.
const HARNESS = `#!/bin/bash
set -uo pipefail
${HOOK_STATE_DIR}
SESSION_ID="$1"
HOOK_task="from-envelope"
INPUT="the-envelope"
COUNT=41
${HOOK_FEATURE_ON}
${TASK_PULSE_JOB}
task_pulse_job
[ -n "\${SHOW_GLOBALS:-}" ] && echo "globals: $HOOK_task $INPUT $COUNT"
exit 0
`;

function run(sessionId: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", [hookFile, sessionId], {
    env: { ...process.env, HOME: home, CODECAST_DIR: path.join(home, ".codecast"), PATH: `${bin}:${process.env.PATH}`, ...env },
  }).toString();
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-task-pulse-"));
  // The reminder jobs run only while their Agent Features entry is on.
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ state_enabled: true, work_enabled: true }, null, 2));
  hookFile = path.join(home, "task-pulse.sh");
  fs.writeFileSync(hookFile, HARNESS, { mode: 0o755 });
  bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\necho PYTHON_CALLED >&2\nexit 1\n", { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("task pulse job", () => {
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

  test("silent while Tasks & Plans is off in Agent Features", () => {
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ work_enabled: false }));
    const id = "pulse-off";
    fs.mkdirSync(path.join(home, ".codecast", "task-pulse"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "task-pulse", `${id}.json`), JSON.stringify({ task: "ct-1" }));
    for (let i = 0; i < 16; i++) expect(run(id)).toBe("");
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ state_enabled: true, work_enabled: true }));
  });

  test("reads a plan alone, a pretty-printed pulse, and takes no id from a non-string", () => {
    const dir = path.join(home, ".codecast", "task-pulse");
    fs.mkdirSync(path.join(dir, "counters"), { recursive: true });
    const at8 = (id: string, pulse: string) => {
      fs.writeFileSync(path.join(dir, `${id}.json`), pulse);
      fs.writeFileSync(path.join(dir, "counters", id), "7\n");
      return run(id);
    };
    expect(at8("plan-only", JSON.stringify({ plan: "pl-7", started: true }))).toContain("working on plan pl-7.");
    expect(at8("pretty", JSON.stringify({ task: "ct-3", plan: "pl-4" }, null, 2))).toContain("working on task ct-3, plan pl-4.");
    expect(at8("nulls", '{"task":null,"plan":7}')).toBe("");
    // A counter file that is not a number starts over instead of failing the arithmetic.
    fs.writeFileSync(path.join(dir, "garbage.json"), JSON.stringify({ task: "ct-1" }));
    fs.writeFileSync(path.join(dir, "counters", "garbage"), "x y\n");
    expect(run("garbage")).toBe("");
    expect(fs.readFileSync(path.join(dir, "counters", "garbage"), "utf-8")).toBe("1\n");
  });

  test("leaves the envelope fields and the other jobs' names alone on the turn it emits", () => {
    const id = "pulse-globals";
    const dir = path.join(home, ".codecast", "task-pulse");
    fs.mkdirSync(path.join(dir, "counters"), { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ task: "ct-9", plan: "pl-9" }));
    fs.writeFileSync(path.join(dir, "counters", id), "7\n");
    const out = run(id, { SHOW_GLOBALS: "1" });
    expect(out).toContain("working on task ct-9, plan pl-9.");
    expect(out).toContain("globals: from-envelope the-envelope 41\n");
  });

  test("carries no JSON parser of its own", () => {
    expect(TASK_PULSE_JOB).not.toContain(HOOK_FIELDS_AWK.slice(0, 40));
    expect(TASK_PULSE_JOB).not.toContain("awk");
    expect(TASK_PULSE_JOB).not.toContain("$(cat");
  });

  test("follows CODECAST_DIR away from ~/.codecast", () => {
    const other = path.join(home, "other-state");
    fs.mkdirSync(path.join(other, "task-pulse", "counters"), { recursive: true });
    fs.writeFileSync(path.join(other, "config.json"), JSON.stringify({ work_enabled: true }));
    fs.writeFileSync(path.join(other, "task-pulse", "elsewhere.json"), JSON.stringify({ task: "ct-5" }));
    fs.writeFileSync(path.join(other, "task-pulse", "counters", "elsewhere"), "7\n");
    expect(run("elsewhere", { CODECAST_DIR: other })).toContain("working on task ct-5.");
    expect(fs.existsSync(path.join(home, ".codecast", "task-pulse", "counters", "elsewhere"))).toBe(false);
  });
});
